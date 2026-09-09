# 前端联调：V2 链模块与 Launch 链槽位（S9 / 决策 0038 增补）

本文是 `chain` 模块（决策 0033）在 S9 之后的前端交接契约增补，只覆盖**双链槽位**
带来的字段；`GET /v2/chain/status` 与 `GET /v2/assets/{assetId}` 的其余字段、
`bscRead` capability、错误码与 `networks` 页规则仍以 `docs/frontend-v2-wallet-api.md`
§1、§3、§4 为准。权威机器契约为 `openapi/loop-api.v2.json`。

## 0. 链模型（硬约束）

后端**恰好两个具名链槽位**，没有链列表，不做通用多链：

| 槽位      | 链                                | 覆盖                                                       |
| --------- | --------------------------------- | ---------------------------------------------------------- |
| `primary` | 恒 `eip155:56`                    | 钱包、资产 registry、行情、Swap、Send、授权、indexer、自选 |
| `launch`  | `eip155:56`（默认）或 `eip155:97` | Launch 目录、Launch 相关页面、将来的 Launch 意图           |

`launch` 槽位由后端 `LAUNCH_CHAIN_ID` 决定，客户端**只信后端发布的值**：
`GET /v2/meta/capabilities` 里 `launch.evidence.launchChainId`（每个部署都有）、
`GET /v2/chain/status.launchChain`、每个 `LaunchSummary.chainId`。
`chain_contract.dart` 里"本步只支持 eip155:56"的校验改为"primary 链 56 **或**
launch 链（后端发布）"；出现其它值按 strict 解析拒绝。

BSC 测试网事实（核验 2026-09-09，`eth_chainId == 0x61`）：chainId 97，原生币 tBNB
（18 位小数，`eip155:97:native`），水龙头 https://www.bnbchain.org/en/testnet-faucet。
RPC URL 永远不会出现在任何响应里。

## 1. `GET /v2/chain/status.launchChain`

`launch` 槽位与 `primary` 相同（`LAUNCH_CHAIN_ID` 未设置或 `56`）时恒为 `null`——
不重复发布主链。`LAUNCH_CHAIN_ID=97` 时：

```json
{
  "launchChain": {
    "chainId": "eip155:97",
    "chainReference": 97,
    "verification": "verified",
    "confirmations": 5,
    "reorgDepthBlocks": 15,
    "head": {
      "blockNumber": "52000000",
      "blockHash": "0x9999…",
      "observedAt": "2026-09-09T10:45:05.000Z"
    },
    "reasonCode": null
  }
}
```

- 键顺序：`chain`、`rpc`、`indexer`、`registry`、`launchChain`、`contractVersion`；
  前五个中前四个只描述 `eip155:56`，与 S5 完全一致。
- `verification` 与主链同枚举：`verified | mismatched | unreachable | unknown`。
  `head` 只在 `verified` 时非空。
- **没有** `endpoints[]`：测试网端点健康不单列，也不下发 `endpointRef`。
- 路由的 503 门槛仍然只看主链：主链未配置 RPC → 整个 `GET /v2/chain/status`
  `503 CAPABILITY_UNAVAILABLE`，无论 launch 槽位如何；launch 槽位失败**只**体现在
  `launchChain.reasonCode`，主链部分照常 200。

| `launchChain.reasonCode`            | `verification` | 含义                                           | networks 页             |
| ----------------------------------- | -------------- | ---------------------------------------------- | ----------------------- |
| `null`                              | `verified`     | 测试网端点已实测 chain 97                      | 正常                    |
| `LAUNCH_CHAIN_RPC_NOT_CONFIGURED`   | `unknown`      | 后端选了 97 但未配置测试网 RPC                 | Launch 链行 unavailable |
| `LAUNCH_CHAIN_VERIFICATION_PENDING` | `unknown`      | 端点已配置，chainId 校验尚未完成               | 可重试                  |
| `LAUNCH_CHAIN_RPC_UNREACHABLE`      | `unreachable`  | 端点不可达                                     | `异常` badge            |
| `LAUNCH_CHAIN_ID_MISMATCH`          | `mismatched`   | 端点返回的不是 chain 97——Launch 相关整块不可用 | `异常` badge            |

`networks` 页只有在 `launchChain !== null` 时才增加一行"BSC 测试网（Launch）"；
`launchChain === null` 时**不显示**任何测试网行（不是 unavailable 占位）。

## 2. `GET /v2/meta/capabilities` → `launch.evidence.launchChainId`

```json
{
  "capabilityId": "launch",
  "availability": "available",
  "reasonCode": null,
  "evidence": {
    "status": "pending",
    "reasonCode": "LAUNCH_CONTRACT_BASELINE_PENDING",
    "launchChainId": "eip155:56"
  }
}
```

- 31 个 capability id 不变；只有 `launch` 的 `evidence` 多 `launchChainId`
  （`eip155:56 | eip155:97`），其它 capability 的 `evidence` 仍只有
  `status` + `reasonCode`。
- `bscRead` 语义不变：只描述 `primary`。测试网可用与否**不影响** `bscRead`。
- 客户端用它决定：Launch 列表/详情/轮次/交易/质押页与签名单是否显示"BSC 测试网"
  徽标与一次性说明（不阻断）。

## 3. 其它受影响的接口

| 接口                                               | 变化                                                                                | 文档                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| `GET /v2/wallets/{walletId}/balances`              | 新增 `launchChain`（tBNB 余额；槽位相同时 `null`）                                  | `docs/frontend-v2-wallet-api.md` §6.1    |
| `GET /v2/launch/overview`、`GET /v2/launches/{id}` | `LaunchSummary.chainId` 变为枚举 `eip155:56 \| eip155:97`（来自存储行，不再是常量） | `docs/frontend-v2-launch-api.md` §1.1    |
| `POST /v2/launch/{launchId}/intents`               | 不变，恒 `503`                                                                      | 同上 §4.5                                |
| 钱包意图（send/approve/revoke/swap）               | 不变：`unsignedTransaction.chainId` 恒 `56`，任何 97 都必须拒绝                     | `docs/frontend-v2-wallet-intents-api.md` |

## 4. 本步明确不做

97 的行情 / GoPlus / DexScreener 数据；97 的资产 registry 与 ERC-20 余额；PancakeSwap
测试网池；Launch 事件 lane；任何 Launch 交易；`BSC_WRITES_ENABLED` 语义变化。02 合约文档
到位后的接入清单见 `docs/decisions/0038-launch-chain-slot-bsc-testnet.md`。
