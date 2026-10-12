# 前端交接契约：测试网领取测试币（testnetFaucet）

- 决策：`docs/decisions/0128-testnet-faucet.md`（S156-api）
- 机器契约：`openapi/loop-api.v2.json`（`pnpm openapi:generate` 生成，勿手改），operationId `getV2TestnetFaucet` / `claimV2TestnetFaucet`
- 能力位：`GET /v2/meta/capabilities` 的 `testnetFaucet`（不是 `V2_MODULES_ENABLED` 模块，永远不会是 `deferred`）
- 只在 BSC Testnet（`LAUNCH_CHAIN_ID=97`）可用；服务端用 operator 热钱包给用户自己的**内嵌钱包**转 tBNB 并调用 MockUSD1 的 `mint(address,uint256)`，用户无需签名
- 发放的是 **MEME v2 交易用的 USD1**（Hooks 工厂 `usd1()`，即 launch2 实例买 NFT、曲线买卖用的那个 USD1；S156b 修正，之前误发到旧 Launch v1 IDO 的 USD1）

## 1. Base URL 与请求头

| 环境        | Base URL                              |
| ----------- | ------------------------------------- |
| Development | `https://api-dev.quant-dinger.cc`     |
| Staging     | `https://api-staging.quant-dinger.cc` |

两个路由都需要：

```
Authorization: Bearer <Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: <app version>
```

`POST` 另需：

```
Idempotency-Key: <UUIDv4；每次新的一次点击新生成；同一次点击的网络重试用同一个>
Content-Type: application/json
```

## 2. 能力位 `testnetFaucet`

```json
{
  "capabilityId": "testnetFaucet",
  "availability": "available",
  "reasonCode": null,
  "evidence": { "status": "notApplicable", "reasonCode": null }
}
```

`availability` 只有 `available` / `unavailable`。`unavailable` 时 `reasonCode` 按下列顺序取第一个命中的：

| reasonCode                               | 含义                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `TESTNET_FAUCET_DISABLED`                | `TESTNET_FAUCET_ENABLED` 未开（默认）                                         |
| `TESTNET_FAUCET_WRONG_CHAIN`             | 不是 97 链（正常启动下不会出现：服务端会拒绝启动）                            |
| `TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED` | 没有 operator 私钥                                                            |
| `TESTNET_FAUCET_USD1_NOT_CONFIGURED`     | 既无 `TESTNET_FAUCET_USD1_ADDRESS`、无 Hooks 工厂、也无 `LAUNCH_USD1_ADDRESS` |
| `TESTNET_FAUCET_RPC_NOT_CONFIGURED`      | 没有 `LAUNCH_BSC_RPC_URLS`                                                    |
| `TESTNET_FAUCET_RUNTIME_UNAVAILABLE`     | 数据库 / 钱包仓库未组装                                                       |

**前端行为**：`unavailable` 时不显示「领取测试币」入口（或置灰，文案「测试币暂不可领」），不要调用两个路由。能力位**不读** operator 余额；余额不足只会在 `POST` 时以 503 `TESTNET_FAUCET_OPERATOR_LOW` 出现。

## 3. `GET /v2/testnet/faucet?walletId=<walletId>`

`walletId` 必须是当前会话用户自己的、`kind=embedded`、未归档的钱包（来自 `GET /v2/wallets`）。

`200`：

```json
{
  "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
  "address": "0x000000000000000000000000000000000000000a",
  "bnbAmount": "0.02",
  "usd1Amount": "500",
  "cooldownSeconds": 86400,
  "available": false,
  "nextAvailableAt": "2026-10-13T08:00:00.000Z",
  "lastGrant": {
    "grantedAt": "2026-10-12T08:00:00.000Z",
    "bnbTransactionHash": "0xb1b1…b1",
    "usd1TransactionHash": "0xc2c2…c2"
  }
}
```

- 金额是十进制字符串，不要转浮点；按原样展示「0.02 tBNB + 500 USD1」。
- `available` 只看冷却（同一钱包地址 `cooldownSeconds` 内已有一次未失败的发放）。`true` 时 `nextAvailableAt` 为 `null`。
- `lastGrant`：该地址最近一次**已发出 tBNB** 的发放；从未领过为 `null`。`usd1TransactionHash` 可能为 `null`（那次 USD1 没铸出，见 §4 PARTIAL）。
- 交易哈希可拼 `https://testnet.bscscan.com/tx/<hash>` 供用户查看。

## 4. `POST /v2/testnet/faucet`

请求体（只允许这一个键）：

```json
{ "walletId": "d64786bb-408d-415d-8a69-6277d56c921b" }
```

`201`：

```json
{
  "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
  "address": "0x000000000000000000000000000000000000000a",
  "bnb": { "amount": "0.02", "transactionHash": "0xb1b1…b1" },
  "usd1": { "amount": "500", "transactionHash": "0xc2c2…c2" },
  "grantedAt": "2026-10-12T08:00:00.000Z",
  "nextAvailableAt": "2026-10-13T08:00:00.000Z"
}
```

- 服务端先发 tBNB、再铸 USD1，两笔都等到 1 个确认才返回 201，所以 201 = 两笔都已上链。请求通常 2–8 秒，按钮要有 loading，**不要**在等待中允许重复点击（若重复点击用同一个 `Idempotency-Key`）。
- 成功后刷新 `GET /v2/wallets/{walletId}/balances`；余额快照可能晚几秒，不要把 201 当作余额已刷新。
- 成功体键集合固定，无额外键；`nextAvailableAt` 恒晚于 `grantedAt`；GET 的 `available=true` ⇔ `nextAvailableAt=null`。
- 同一个 `Idempotency-Key` 重放：`201` 时返回字节相同的同一份 201；失败结果重放返回同样的错误；仍在进行中返回 409 `TESTNET_FAUCET_IN_FLIGHT`。

## 5. 错误码（七字段错误体，`detailsSafe.reasonCode` 区分）

| HTTP | code                             | detailsSafe                                                                                                                          | 前端处理                                                                   |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | —                                                                                                                                    | 程序错误（walletId 格式、多余键、缺 Idempotency-Key）                      |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                                    | 走统一重新登录                                                             |
| 403  | `PERMISSION_DENIED`              | `reasonCode: TESTNET_FAUCET_WALLET_NOT_OWNED`                                                                                        | 只能给自己的内嵌钱包领；外部钱包不显示入口                                 |
| 409  | `IDEMPOTENCY_CONFLICT`           | —                                                                                                                                    | 同一个 key 换了 walletId；新生成 key                                       |
| 409  | `RESOURCE_CONFLICT`              | `reasonCode: TESTNET_FAUCET_IN_FLIGHT`                                                                                               | 上一次还在进行；稍后 `GET` 查看                                            |
| 429  | `RATE_LIMITED`                   | `reasonCode: TESTNET_FAUCET_COOLDOWN`, `nextAvailableAt`                                                                             | 显示「下次可领：<本地时间>」，按钮置灰                                     |
| 503  | `CAPABILITY_UNAVAILABLE`         | `reasonCode: TESTNET_FAUCET_PARTIAL`, `bnbTransactionHash`, `usd1TransactionHash`（仅当那笔 mint 发出过才有此键）, `nextAvailableAt` | tBNB 已到账、USD1 没铸成；冷却照常计时；提示「tBNB 已到账，USD1 发放失败」 |
| 503  | `CAPABILITY_UNAVAILABLE`         | `reasonCode: TESTNET_FAUCET_SUBMISSION_UNKNOWN`, `bnbTransactionHash`, `nextAvailableAt`                                             | tBNB 已广播但未等到确认，可能稍后到账；冷却已计时；提示「到账确认中」      |
| 502  | `PROVIDER_UNREACHABLE`           | `reasonCode: TESTNET_FAUCET_TRANSFER_FAILED`                                                                                         | 什么都没转出，不计冷却；可新生成 key 重试                                  |
| 503  | `CAPABILITY_UNAVAILABLE`         | `reasonCode`: §2 表中任一，或下列之一                                                                                                | 显示「测试币暂不可领」，不自动重试                                         |
|      |                                  | `TESTNET_FAUCET_OPERATOR_LOW`                                                                                                        | 发币账户余额不足（需运维充值）                                             |
|      |                                  | `TESTNET_FAUCET_USD1_UNAVAILABLE`                                                                                                    | USD1 合约不可读或 mint 会回滚                                              |
|      |                                  | `TESTNET_FAUCET_CHAIN_READ_FAILED`                                                                                                   | RPC 读失败，可稍后重试                                                     |
|      |                                  | `TESTNET_FAUCET_BUSY`                                                                                                                | 其他人正在领，稍后重试                                                     |
| 503  | `REQUEST_TIMEOUT`                | —                                                                                                                                    | 服务端仍可能完成；用同一个 key 重试或 `GET` 查看 `lastGrant`               |

`429` / `503 TESTNET_FAUCET_PARTIAL` / `503 TESTNET_FAUCET_SUBMISSION_UNKNOWN` 之后 `GET` 都会返回 `available: false` 与同一个 `nextAvailableAt`。

## 6. unavailable 行为汇总

- 能力位 `unavailable` → 不显示入口、不调接口；两个路由此时都会返回 503 + 同一个 reasonCode。
- 任何 503 都不显示成功；201 之外的任何结果都不得显示「已到账」。
- 主网（56）环境永远 `unavailable`（服务端在 56 上开启会拒绝启动）。
