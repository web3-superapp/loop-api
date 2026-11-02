# 前端联调：发送 LOOP 项目 NFT（S339 / 决策 0194，主代理决策 0267）

本文是 `POST /v2/wallet-intents/send-nft` 的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`（operationId `prepareV2SendNftIntent`）。通用规则（错误体七字段、
Bearer、`X-Loop-Contract-Version: 2.0`、intent 资源形状、状态机、`broadcast-report`、
`tx-result` 轮询）完全沿用 `docs/frontend-v2-wallet-intents-api.md` §2–§4；本文只写差异。

## 1. 启用条件

- Base URL：同其他 `/v2`（Development `https://api-dev…`，staging `https://api-staging…`）。
- 后端 `V2_MODULES_ENABLED` 含 `sendApprovals`（否则路径 404）。
- 服务端开关 `NFT_SEND_ENABLED`，**默认 off**。off 时：
  - `POST /v2/wallet-intents/send-nft` → `503 CAPABILITY_UNAVAILABLE`，`detailsSafe.reasonCode = "NFT_SEND_DISABLED"`；
  - `POST /v2/wallet-intents/send/preflight` 只认 `eip155:56`，带 `chainId: "eip155:97"` → `422 CHAIN_MISMATCH`。
  - App：入口隐藏，或点了 toast「暂不支持发送 NFT」（不加说明文字，见 docs/53 §三）。
- on 时还需要：`BSC_WRITES_ENABLED`、launch slot RPC 可用且链已验证（否则 `503 CAPABILITY_UNAVAILABLE`，
  `detailsSafe` 为 `null` 或 `{reasonCode: "NFT_SEND_CHAIN_UNAVAILABLE"}`）。
- `/v2/meta/capabilities` 新增一行 `capabilityId: "nftSend"`（旧版本 App 按 loop-mobile 决策 0180 跳过未知 id）：
  `available` = 开关 on + `sendApprovals` 已组装 + `BSC_WRITES_ENABLED` + launch slot 开放且有 RPC 与 launch2 读模型；
  否则 `unavailable`，`reasonCode` 依次为 `NFT_SEND_DISABLED` / `SEND_APPROVALS_RUNTIME_DEFERRED` /
  `BSC_WRITES_DISABLED` / `NFT_SEND_CHAIN_UNAVAILABLE`；`evidence` 恒为 `{status: "notApplicable", reasonCode: null}`。
  App 据此预先决定是否显示「发送」入口；链实时验证仍以本路由的 503 为准。

## 2. 流程

1. 用户在 NFT 卡片上点「发送」：卡片来自 `GET /v2/launch2/me/positions`（`nft.held > 0`）或
   个人主页 NFT tab。`tokenId` = `nft.mintedTokenId`（见 §6 限制）；`contractAddress` = 该 instance 的
   `contracts.nft`（`GET /v2/launch2/instances/{instanceId}` 的 `instance.contracts.nft`——持仓行本身只带
   `memeAddress`，不带 NFT 合约地址）；`chainId` = launch slot（staging `eip155:97`，与 launch2 instance 同链）。
2. 收款地址步骤：`POST /v2/wallet-intents/send/preflight`，body
   `{ walletId, address, chainId: "eip155:97" }`（开关 on 时才接受 97；回 `chainId: "eip155:97"`，
   `recipient.isContract` 在 97 上读）。告警键与 send 相同。
3. 确认页：`POST /v2/wallet-intents/send-nft` → intent（`state = awaiting_signature` 才可签）。
4. Privy `eth_sendTransaction(unsignedTransaction)`，字段一个都不能改（`chainId` 是 **97**）。
5. `POST /v2/wallet-intents/{intentId}/broadcast-report` `{txHash}` → `submitted`。
6. `tx-result` 轮询 `GET /v2/wallet-intents/{intentId}` 到 `confirmed` / `reverted` / `unknown`。
7. 对账确认后，launch2 lane 读到 ERC-721 `Transfer`，`GET /v2/launch2/me/positions` 的
   `nft.held` 减 1（通常在下一次 lane tick 内，十几秒级）。

没有金额步骤；没有授权步骤（发送方就是 owner）。

## 3. `POST /v2/wallet-intents/send-nft`

Headers：`Authorization: Bearer <privy>`、`X-Loop-Contract-Version: 2.0`、`X-Loop-Client-Version`、
`Idempotency-Key: <小写 UUIDv4>`（必须）、`Content-Type: application/json`。

请求（全部必填，未知键 400；`tokenId` 必须是 JSON 字符串，十进制，无前导 0）：

```json
{
  "walletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "chainId": "eip155:97",
  "contractAddress": "0x8f2a0c3b6d4e5f60718293a4b5c6d7e8f9012345",
  "tokenId": "7",
  "recipientAddress": "0x00000000000000000000000000000000000000B2"
}
```

响应 `201`（新建）/ `200`（同 key 同 body 重放，返回同一 intent）：

```json
{
  "intentId": "2d1c7f0e-9a8b-4c6d-8e5f-1a2b3c4d5e6f",
  "kind": "send_nft",
  "state": "awaiting_signature",
  "walletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "chainId": "eip155:97",
  "review": {
    "kind": "send_nft",
    "asset": {
      "assetId": "eip155:97:0x8f2a0c3b6d4e5f60718293a4b5c6d7e8f9012345",
      "address": "0x8f2a0c3b6d4e5f60718293a4b5c6d7e8f9012345",
      "symbol": "LCAT",
      "decimals": 0
    },
    "amount": { "raw": "1", "display": "1" },
    "recipient": {
      "address": "0x00000000000000000000000000000000000000b2",
      "checksumAddress": "0x00000000000000000000000000000000000000B2",
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
      "functionName": "safeTransferFrom",
      "selector": "0x42842e0e",
      "args": {
        "from": "0x00000000000000000000000000000000000000a1",
        "to": "0x00000000000000000000000000000000000000b2",
        "tokenId": "7"
      }
    },
    "fee": {
      "gasLimit": "62400",
      "type": "legacy",
      "maxFeePerGas": null,
      "maxPriorityFeePerGas": null,
      "gasPrice": "1000000000",
      "maximumFeeRaw": "62400000000000",
      "maximumFee": "0.0000624",
      "observedAt": "2026-11-02T13:00:00.000Z"
    },
    "balance": {
      "blockNumber": "61234567",
      "blockHash": "0x…64 hex…",
      "observedAt": "2026-11-02T13:00:00.000Z",
      "rawBalance": "1",
      "displayBalance": "1",
      "rawNativeBalance": "500000000000000000",
      "gasReserveRaw": "5000000000000000"
    },
    "swap": null,
    "nft": {
      "contractAddress": "0x8f2a0c3b6d4e5f60718293a4b5c6d7e8f9012345",
      "tokenId": "7",
      "projectName": "Loop Cat Project"
    }
  },
  "reviewSha256": "…64 hex…",
  "factsObservedAt": "2026-11-02T13:00:00.000Z",
  "expiresAt": "2026-11-02T13:02:00.000Z",
  "simulation": {
    "status": "passed",
    "source": "rpc_call",
    "observedAt": "2026-11-02T13:00:00.000Z",
    "reasonCode": null
  },
  "policy": {
    "configVersion": "bscWriteCanaryV1",
    "canaryMaxUsd": "5",
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
    "from": "0x00000000000000000000000000000000000000a1",
    "to": "0x8f2a0c3b6d4e5f60718293a4b5c6d7e8f9012345",
    "data": "0x42842e0e…",
    "value": "0x0",
    "gas": "0xf3c0",
    "nonce": "0x7",
    "type": "legacy",
    "maxFeePerGas": null,
    "maxPriorityFeePerGas": null,
    "gasPrice": "0x3b9aca00"
  },
  "authorizationPayload": null,
  "result": {
    "transactionHash": null,
    "providerActionId": null,
    "reasonCode": null,
    "receipt": null
  },
  "version": "1",
  "createdAt": "2026-11-02T13:00:00.000Z",
  "updatedAt": "2026-11-02T13:00:00.000Z",
  "contractVersion": "2.0"
}
```

确认页取值：NFT 图 = 持仓里的 `nftImageUrl`（或 launch2 NFT metadata）；项目名 =
`review.nft.projectName`；`#tokenId` = `review.nft.tokenId`（与 `decodedCall.args.tokenId` 相同）；收款方 =
`review.recipient.checksumAddress`；网络费 = `review.fee.maximumFee`（tBNB）；合约地址 = `review.nft.contractAddress`
（与 `review.asset.address`、`unsignedTransaction.to` 相同）。`fee.type` 在 BSC Testnet
通常是 `legacy`，也可能是 `eip1559`，按 send 的规则显示。

codec 注意（相对 send 的新值）：`kind` 新值 `send_nft`；`decodedCall.functionName` 新值
`safeTransferFrom`（args 键 `from` / `to` / `tokenId`）；`review.nft = { contractAddress, tokenId, projectName }`
**只出现在 `send_nft` 的 review 上**（其他 kind 的 review 键集不变）；`chainId` 为
launch slot（`eip155:97`），`unsignedTransaction.chainId` 为 `97`；`review.asset.assetId` 以 `eip155:97:` 开头；
`asset.decimals = 0`；`policy.exposureBasis = "none"` 且 `valueUsd = null`。

## 4. 列表 `GET /v2/wallet-intents`

新增可选 query `includeKinds`（逗号分隔，目前只有 `send_nft`）。**不带时列表不含 `send_nft`**——旧版本
App 的 codec 会因未知 kind 整页解析失败，所以默认隐藏。能解析 `send_nft` 的新 App 请求
`GET /v2/wallet-intents?includeKinds=send_nft`；翻页时 `cursor` 与 `includeKinds` 一起带（cursor 绑定 opt-in
集合，不一致 → `400 INVALID_REQUEST`）。`includeKinds` 取值非法（未知 kind、重复、空串、大写）→ 400。

`GET /v2/wallet-intents/{intentId}`、`cancel`、`broadcast-report` 对 `send_nft` 不需要任何额外参数。

## 5. 错误码

| HTTP | code                             | detailsSafe.reasonCode                 | 含义 / App 行为                                                     |
| ---- | -------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | —                                      | 形状错（tokenId 非字符串 / 非十进制、零地址、未知键、缺 header）    |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                      | 重新登录                                                            |
| 403  | `POLICY_BLOCKED`                 | `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST` | 收款方不在金丝雀名单（名单非空时；与 ERC-20 send 一致）             |
| 404  | `NOT_FOUND`                      | —                                      | walletId 不存在 / 已归档                                            |
| 409  | `IDEMPOTENCY_CONFLICT`           | —                                      | 同 key 不同 body                                                    |
| 409  | `INSUFFICIENT_BALANCE`           | —                                      | 原生币（tBNB）不够付网络费（沿用原生币不足错误码）                  |
| 409  | `SIMULATION_FAILED`              | —                                      | 预执行 revert 且收款方是普通地址（链上不会执行）                    |
| 422  | `CHAIN_MISMATCH`                 | —                                      | `chainId` 不是 launch slot                                          |
| 422  | `VALIDATION_FAILED`              | `NFT_NOT_OWNED`                        | `ownerOf(tokenId)` 不是本钱包（或 token 不存在）                    |
| 422  | `VALIDATION_FAILED`              | `NFT_CONTRACT_UNSUPPORTED`             | 合约不是 LOOP 项目 NFT                                              |
| 422  | `VALIDATION_FAILED`              | `NFT_RECIPIENT_REJECTS`                | 收款方是合约且 `onERC721Received` 拒收（预执行失败）                |
| 422  | `VALIDATION_FAILED`              | `RECIPIENT_SELF`                       | 发给自己                                                            |
| 422  | `VALIDATION_FAILED`              | —                                      | 外部钱包（非内置钱包）不能签                                        |
| 503  | `CAPABILITY_UNAVAILABLE`         | `NFT_SEND_DISABLED`                    | 开关关 → 隐藏入口 / toast「暂不支持发送 NFT」                       |
| 503  | `CAPABILITY_UNAVAILABLE`         | `NFT_SEND_CHAIN_UNAVAILABLE`           | launch slot 未开放 / 无 RPC / 无 launch2 读模型                     |
| 503  | `CAPABILITY_UNAVAILABLE`         | —                                      | `BSC_WRITES_ENABLED` 关、链未验证、`ownerOf` / 余额读失败（可重试） |

预执行估算不可用（RPC 估不出 gas）时不报错：返回 `201`，`state = "prepared"`、`signing.allowed = false`、
`signing.reasonCode = "GAS_ESTIMATE_UNAVAILABLE"` 或 `"SIMULATION_UNAVAILABLE"`，确认按钮禁用，与 send 相同。

## 6. 已知限制

- 持仓 / viewer 的 `nft` 默认只有 `mintedTokenId`（这个地址自己铸的那枚）和 `held`；**收到的 NFT 没有 tokenId**，
  自己铸的那枚转走后 `mintedTokenId` 不变。后端已备好可选键 `nft.heldTokenIds: string[]`（当前持有的 token ID，
  升序、最多 100，来自 ERC-721 Transfer 索引），在 `LAUNCH2_NFT_HELD_TOKEN_IDS_EMIT`（**默认 off**）之后，
  出现在 `GET /v2/launch2/instances/{id}` 的 `viewer.nft` 与 `GET /v2/launch2/me/positions` 的 `positions[].nft`。
  ebf95629 的 launch2 codec 对 `nft` 是严格键集，所以 App 先发版接受该可选键，再开开关。开关 off 时 App 只在
  `held > 0 && mintedTokenId != null` 时显示「发送」并以 `mintedTokenId` 为 tokenId（该枚已不在本钱包 → `NFT_NOT_OWNED`）；
  键存在时以 `heldTokenIds` 为准（可发送其中任意一枚）。
- 钱包活动列表不新增 NFT 转账行；结果以 intent（`tx-result`）为准。
- `isFirstRecipient` 在 BSC Testnet 上基本恒为 `true`（只看 ERC-20 索引）。
