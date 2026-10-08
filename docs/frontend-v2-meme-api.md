# 前端联调：V2 MEME 曲线发射台（S116 / 决策 0101；S116b / 决策 0103 修订）

> S116b 变更（决策 0103）：§3/§4 已毕业无 DexScreener 报价时回退读池子 `slot0`（`priceSource.source = "pool_slot0"`）；
> §4 `graduation.residual` 取整零头投影为 `null`；§9 `quote.source` 新增 `pool_slot0`、`quality` 新增 `derived`；
> §10 毕业兜底等待改为 15 秒（可配）。

本文是 `meme` 模块的前端交接契约，S117-mobile 只以本文为准。权威机器契约为
`openapi/loop-api.v2.json`（tag `meme`）。通用规则（Base URL、`X-Request-ID`、错误体七字段、
Bearer、`X-Loop-Contract-Version: 2.0`、`Idempotency-Key`）沿用
`docs/frontend-v2-session-api.md` 与 `docs/api-v2-conventions.md`。合约参数与数学见
`LOOP/docs/10-MEME曲线合约接口需求.md`。

覆盖页面：MEME Tab 发射台段（列表四 chips + 创建入口）、`/meme/create`（三步）、`/meme/token?id=`
（代币页：价格区、进度区、图表、持有者/动态/关于、底部交易栏）、`/meme/token/holders?id=`、
`/meme/token/trades?id=`；行情段 `category=meme` 见 §9。

## 0. 速查

| 页面区域               | 接口                                                                                               | 字段                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 列表四 chips           | `GET /v2/meme/tokens?tab=new\|hot\|graduating\|graduated`                                          | §2 行：`name/symbol/imageUrl/marketCapUsd1/holderCount/priceUsd1/change1hPct/progressBps/status` |
| 代币页价格区           | `GET /v2/meme/tokens/{id}`                                                                         | `priceUsd1`、`change1hPct`（1h）、`marketCapUsd1`、`priceSource`                                 |
| 进度区                 | 同上                                                                                               | `progressBps`、`curve.realUsd1` / `curve.graduationUsd1Estimate`                                 |
| 我的持仓 / 上限 / 授权 | 同上 `viewer`                                                                                      | `balance`、`walletCapRemaining`、`allowanceUsd1`、`allowanceToken`                               |
| 图表                   | `GET /v2/meme/tokens/{id}/candles?interval=1m\|5m\|15m\|1h\|4h\|1d`                                | `items[].open/high/low/close/volumeUsd1`、`frozenAt`                                             |
| 动态 Tab               | `GET /v2/meme/tokens/{id}/trades`                                                                  | `isBuy`、`usd1Amount`、`tokenAmount`、`wallet`/`account`、`at`                                   |
| 持有者 Tab             | `GET /v2/meme/tokens/{id}/holders`                                                                 | `balance`、`shareBps`、`isCreator`、`isViewer`、`account`、`frozenAt`                            |
| 买卖面板报价           | `GET /v2/meme/quote?tokenId&side&amount&walletId`                                                  | `out`、`fee`、`priceImpactBps`、`walletCapHit`、`belowMinBuy`、`refund`                          |
| 创建第 3 步 / 确认     | `POST /v2/meme/tokens` → `POST …/intents {kind:"create"}`                                          | `predictedAddress`、`vanity`、`salt`、`metadataHash`                                             |
| 买 / 卖                | `POST /v2/meme/tokens/{id}/intents {kind:"buy"\|"sell"}` → 签名 → `…/broadcast-report` → 轮询 §8.4 | `approval`、`unsignedTransaction`、`state`                                                       |

## 1. 启用条件与 capability

- 后端 `V2_MODULES_ENABLED` 必须含 `meme`；未启用时所有 `/v2/meme/*` 为 `404 NOT_FOUND`。
- `GET /v2/meta/capabilities` 新增 `meme`：

| availability  | reasonCode                                                  | 含义 / UI                                                                                                                                                 |
| ------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deferred`    | `MEME_MODULE_NOT_ENABLED`                                   | 模块未启用：发射台段显示 `LoopInlineUnavailable`                                                                                                          |
| `unavailable` | `MEME_RUNTIME_UNAVAILABLE`                                  | 后端缺库或 cursor 密钥                                                                                                                                    |
| `unavailable` | `MEME_CONTRACT_NOT_CONFIGURED` / `MEME_USD1_NOT_CONFIGURED` | 合约未配置：**所有 `/v2/meme/*` 返回 503**，同上显示不可用                                                                                                |
| `available`   | `null`                                                      | 可用。`evidence.status=confirmed`（`MEME_CONTRACT_OBSERVED`）= 已在链上核对合约；`pending` 时读接口仍可用，链上读（viewer、报价链基准、Intent）可能不可用 |

不可用分支：路由返回 `503 CAPABILITY_UNAVAILABLE`，`detailsSafe.reasonCode` 为上表原因，
**不返回空列表冒充没有代币**。

## 2. 数字约定

- **原始金额**：`*Amount`、`balance`、`fee`、`refund`、`out`、`expectedOut`、`minOut`、`curve.*`、
  `allowance*`、`walletCapRemaining` 都是 **18 位小数的最小单位整数字符串**（USD1 与代币都是 18 位）。
  显示时除以 1e18；永远不要转成 JS/Dart double 后再做加减。
- **价格类**：`priceUsd1`、`marketCapUsd1`、`volume24hUsd1`、`priceAfter`、K 线 OHLC、`volumeUsd1`、
  `priceBefore/After`：**USD1 计价的十进制字符串**（已除以 1e18），USD1 按 1 美元计（与 Launch 同规则）。
- **百分比**：`change1hPct`，两位小数字符串，可为负，如 `"76.89"`、`"-3.10"`；`null` = 不适用。
- **基点**：`progressBps`（已售 / 8 亿，0–10000）、`shareBps`（余额 / 10 亿总量）、`priceImpactBps`、
  `tradeFeeBps`，整数。
- **请求金额**：`usd1Amount`、`tokenAmount`、报价 `amount` 用 **整币十进制字符串**（最多 18 位小数，如 `"10"`、
  `"0.5"`）；传 JSON number 是 `400`。`minOut` 例外，是原始整数字符串（直接回传报价里的 `out` 派生值）。
- 时间：ISO 8601 UTC。地址、哈希：小写 `0x`。

## 3. 列表 `GET /v2/meme/tokens`

Query：`tab`（默认 `new`）、`limit`（1–50，默认 30）、`cursor`；`cursor` 与 `limit` 互斥（同时给 `400`）。

| tab          | 范围与排序                                                        |
| ------------ | ----------------------------------------------------------------- |
| `new`        | 已上链（`trading/full/graduated/paused`），按上链时间倒序         |
| `hot`        | 已上链，按最近 1 小时钱包侧 USD1 成交额倒序；排名每 60 秒刷新一次 |
| `graduating` | `trading` 且进度 ≥ 50%，按已售量倒序                              |
| `graduated`  | `graduated`，按毕业时间倒序                                       |

```json
{
  "tab": "new",
  "items": [
    {
      "memeTokenId": "9ea3e259-6148-4c43-a4be-87ad07223916",
      "tokenAddress": "0xac42e9101f379437f3cce49a5b58609dd9a0ca94",
      "name": "Frog",
      "symbol": "FROG",
      "imageUrl": "https://api-dev.example/v2/media/2f0c…webp",
      "creator": {
        "publicProfileId": "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
        "displayName": "frogmaker",
        "avatarRef": null
      },
      "status": "trading",
      "progressBps": 3327,
      "priceUsd1": "0.000009891332712022",
      "marketCapUsd1": "9891.33271202236719478",
      "change1hPct": "76.89",
      "volume24hUsd1": "1980",
      "holderCount": 12,
      "tradeCount": 40,
      "createdAt": "2026-10-08T00:00:00.000Z",
      "graduatedAt": null,
      "pool": null,
      "priceSource": {
        "source": "loop_curve",
        "observedAt": "2026-10-08T03:00:00.000Z"
      }
    }
  ],
  "nextCursor": "eyJ2Ij…",
  "rules": {
    "configVersion": "memeLaunchpadV1",
    "effectiveAt": "2026-10-08T00:00:00.000Z",
    "graduatingProgressBps": 5000,
    "hotWindowSeconds": 3600
  },
  "observedAt": "2026-10-08T03:00:05.000Z",
  "contractVersion": "2.0"
}
```

行字段：

- `creator`：有激活公开资料时给（点进 `/v2/profiles/{publicProfileId}`），否则 `null`（显示钱包缩写）。
- `priceUsd1 / marketCapUsd1`：未毕业来自曲线快照（`priceSource.source = "loop_curve"`）；**已毕业**先取
  DexScreener（`"dexscreener"`，仅主网 56）；DexScreener 没有报价时（测试网 97 毕业代币恒如此，或主网新池尚未收录）
  回退读该代币自己的 PancakeSwap V3 池 `slot0().sqrtPriceX96` 推价（`"pool_slot0"`，USD1 按 1 美元计，
  `marketCapUsd1` = 价格 × 10 亿枚，1.5 秒缓存，`observedAt` 为读链时刻）。来源行文案建议：
  `loop_curve`「内盘曲线」、`dexscreener`「DexScreener」、`pool_slot0`「池子推算」。
  读链也失败时两者为 `null`，并多一个 `quoteUnavailable.reasonCode`：`MEME_DEX_CHAIN_NOT_PRICED`（测试网）、
  `MEME_DEX_QUOTE_UNAVAILABLE` 或行情 Provider 原因；草稿/待上链为 `MEME_TOKEN_NOT_ON_CHAIN`。
  `priceSource.source` 枚举新增 `pool_slot0`，客户端解码请放宽（未知值按「无来源行」处理，不要崩）。
- `change1hPct`：与 1 小时前最后一笔成交价（没有则与开盘价 V0/T0）相比；毕业后为 `null`。
- `progressBps`：进度条；`status = graduated` 时显示「已毕业」标签代替进度条。
- 空列表 = 真的没有（「还没有代币，来创建第一个」）；不可用时是 503，不是空列表。

## 4. 代币详情 `GET /v2/meme/tokens/{memeTokenId}`

列表行全部字段 +：

```json
{
  "memeToken": {
    "…": "列表行字段",
    "description": "ribbit",
    "links": {
      "twitter": "https://x.com/frog",
      "telegram": null,
      "website": null
    },
    "metadataHash": "0xe704…9072",
    "salt": "0xd953…c1ba",
    "predictedAddress": "0xe6b1a3b4c4e370ea4760ed9ef299efc77caeea1c",
    "vanity": false,
    "curve": {
      "vUsd1": "7980000000000000000000",
      "vToken": "806766917293233082706766918",
      "realUsd1": "1980000000000000000000",
      "sold": "266233082706766917293233082",
      "saleSupply": "800000000000000000000000000",
      "poolSupply": "200000000000000000000000000",
      "totalSupply": "1000000000000000000000000000",
      "graduationUsd1Estimate": "16982417582417582417583",
      "tradeFeeBps": 100,
      "walletCapTokens": "40000000000000000000000000",
      "minBuyUsd1": "1000000000000000000"
    },
    "contract": {
      "address": "0xe108d45e3e9d7b8c9c02c5e10544ad811cb39b8a",
      "version": "1.0.0",
      "chainId": "eip155:97",
      "chainReference": 97,
      "explorerUrl": "https://testnet.bscscan.com/token/0xac42…ca94"
    },
    "viewer": {
      "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
      "balance": "10000000000000000000",
      "usd1Balance": "1000000000000000000000",
      "walletCapRemaining": "39999990000000000000000000",
      "allowanceUsd1": "0",
      "allowanceToken": "0"
    },
    "graduation": null,
    "source": {
      "source": "loop_indexer",
      "observedAt": "2026-10-08T03:00:05.000Z"
    }
  },
  "contractVersion": "2.0"
}
```

- 进度区：「内盘进度 `progressBps/100`%」；「已募 `curve.realUsd1` / ≈`curve.realUsd1`（打满时 17,582）」，
  打满募集额 = `realUsd1` 在 `sold = saleSupply` 时的值，固定约 17,582.42 USD1；
  `graduationUsd1Estimate` 是扣 600 毕业费后进池的 USD1（16,982.42）。
- `viewer`：调用者**当前激活钱包**的链上读数（1.5 秒缓存）。`null` 时看 `viewerUnavailable.reasonCode`：
  `MEME_VIEWER_WALLET_MISSING`（没有激活钱包）、`MEME_CONTRACT_READ_FAILED` / `MEME_CHAIN_RPC_UNREACHABLE`
  等（读链失败，不能当作 0）。草稿没有 `viewer`（`null` 且无 `viewerUnavailable`）。
  `walletCapRemaining` 毕业后为 `null`（不限）。「我的持仓」行 = `balance > 0` 时显示。
- `graduation`（仅 `graduated`）：

```json
{
  "pool": "0x7777…7777",
  "lpBurnTx": "0x5000…",
  "lpTokenId": "42",
  "usd1ToPool": "16982000000000000000000",
  "tokensToPool": "200000000000000000000000000",
  "feeUsd1": "600000000000000000000",
  "at": "2026-10-08T05:00:00.000Z",
  "residual": null
}
```

`lpBurnTx` 就是毕业交易（LP NFT 直接铸给 `0x…dEaD`）。`residual` 非 null = 毕业时池已存在，
部分资金留在合约（`{ usd1Left, tokensLeft }`，wei 字符串，只能由运营再注池，不能取走）。零头不显示：
每次毕业都会有取整零头（S118 实测 `usd1Left = 100012`、`tokensLeft = 23` wei），不足 1 USD1 **且** 不足 1 枚时
后端投影为 `null`。三态：无残余事件 → `null`；仅零头 → `null`；≥ 1 USD1 或 ≥ 1 枚 → 对象。

已毕业时价格区见 §3：测试网显示 `pool_slot0` 推算价，读链失败才是 `quoteUnavailable`。

- 草稿与 `pending_chain` 只有创建者能看；其他人 `404 NOT_FOUND / MEME_TOKEN_NOT_FOUND`。

## 5. 动态 / K 线 / 持有者

### 5.1 `GET /v2/meme/tokens/{id}/trades?cursor&limit`（limit ≤ 100，默认 50，新→旧）

```json
{
  "memeTokenId": "9ea3…",
  "items": [
    {
      "txHash": "0x0202…",
      "logIndex": 3,
      "blockNumber": "135600301",
      "wallet": "0x000000000000000000000000000000000000000a",
      "account": null,
      "isBuy": true,
      "usd1Amount": "5000000000000000000",
      "tokenAmount": "890000000000000000000000",
      "feeUsd1": "50000000000000000",
      "priceAfter": "0.0000056",
      "at": "2026-10-08T00:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "source": { "source": "loop_indexer", "observedAt": "…" },
  "contractVersion": "2.0"
}
```

`usd1Amount` 是**钱包侧**金额：买 = 实付（含 1% 费、不含退款），卖 = 实收（已扣费）。`account` 有公开资料时给，
否则客户端显示钱包缩写。行的唯一键 = `txHash + logIndex`。

### 5.2 `GET /v2/meme/tokens/{id}/candles?interval&limit`

`interval` = `1m|5m|15m|1h|4h|1d`（默认 `15m`），`limit` ≤ 300（默认 200）= 最近 N 个**有成交的**桶，按时间升序；
空桶不补（图表组件自行连线）。OHLC 是每笔成交后的曲线价；毕业后 `frozenAt` = 毕业时间，K 线停在那里，客户端切 DEX 行情
（Swap 页 / `GET /v2/market/assets/{assetId}/candles`）。

```json
{
  "memeTokenId": "9ea3…",
  "interval": "5m",
  "items": [
    {
      "openTime": "2026-10-08T00:00:00.000Z",
      "open": "0.0000056",
      "high": "0.0000057",
      "low": "0.0000056",
      "close": "0.00000565",
      "volumeUsd1": "5",
      "tradeCount": 2
    }
  ],
  "frozenAt": null,
  "source": { "source": "loop_indexer", "observedAt": "…" },
  "contractVersion": "2.0"
}
```

### 5.3 `GET /v2/meme/tokens/{id}/holders?cursor&limit`（余额倒序）

```json
{
  "memeTokenId": "9ea3…",
  "holderCount": 12,
  "frozenAt": null,
  "items": [
    {
      "wallet": "0x…0a",
      "account": null,
      "balance": "100000000000000000000000000",
      "shareBps": 1000,
      "isCreator": true,
      "isViewer": true
    }
  ],
  "nextCursor": null,
  "source": { "source": "loop_indexer", "observedAt": "…" },
  "contractVersion": "2.0"
}
```

持仓 = 曲线买入减卖出的净额（钱包之间的转账不计）；`shareBps` 以 10 亿总量为分母。毕业后 `frozenAt` 非空，
文案「分布冻结于毕业时」。

## 6. 报价 `GET /v2/meme/quote?tokenId&side=buy|sell&amount[&walletId]`

```json
{
  "quote": {
    "memeTokenId": "9ea3…",
    "side": "buy",
    "amountIn": "10000000000000000000",
    "out": "999636100727544464736354",
    "fee": "100000000000000000",
    "refund": "0",
    "priceImpactBps": 24,
    "priceBefore": "0.000009891332712022",
    "priceAfter": "0.000009915890340167",
    "minOutAtDefaultSlippage": "989639739720269020088990",
    "walletCapHit": false,
    "walletCapRemaining": "39999990000000000000000000",
    "belowMinBuy": false
  },
  "basis": { "source": "chain", "blockNumber": "135600320", "observedAt": "…" },
  "contractVersion": "2.0"
}
```

- 买：`amount` = 付出的 USD1（含 1% 费）；`out` = 得到的代币；`refund` > 0 表示这笔会**补满**曲线，多余 USD1 不扣。
  卖：`amount` = 卖出的代币；`out` = 到手 USD1（已扣费）；无 `refund`。
- `walletCapHit`：持仓 + `out` > 4,000 万枚（传 `walletId` 时按该钱包链上余额，否则只看 `out`）——面板先提示，不要等签名失败。
  `belowMinBuy`：买入 < 1 USD1。
- `basis.source = "chain"` = 链上当前曲线；`"loop_indexer"` = 链不可读时用索引快照（数字可能落后几个块）。
- 错误：`409 DATA_STALE`（`MEME_CURVE_FULL` 打满待毕业、`MEME_CURVE_NOT_TRADING` + `detailsSafe.status`、
  `MEME_TOKEN_NOT_ON_CHAIN`）；`422 VALIDATION_FAILED / MEME_SELL_EXCEEDS_BALANCE`（卖出超过已售量）；`404`。

## 7. 创建 `POST /v2/meme/tokens`（Idempotency-Key 必填）

```json
{
  "name": "Frog",
  "symbol": "FROG",
  "description": "ribbit",
  "imageMediaId": "2f0c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "links": {
    "twitter": "https://x.com/frog",
    "telegram": "https://t.me/frog",
    "website": "https://frog.example"
  }
}
```

- `name` 1–32 字符（首尾空格去掉）；`symbol` 2–10 位 `A-Z0-9`（客户端先转大写）；`description` ≤ 500；
  `links` 只收 https，空字符串视为未填；`imageMediaId` = 本人通过 `POST /v2/media/community-logos`
  （multipart `file`，512×512 WebP，S107 同一管线）上传得到的 `mediaId`，裁 1:1 在客户端做。
- `201` = §4 的详情（`status: "draft"`，`tokenAddress: null`，`priceUsd1: null` + `quoteUnavailable`
  `MEME_TOKEN_NOT_ON_CHAIN`）。第 3 步用：`predictedAddress`（尾号高亮）、`vanity`（`false` 时提示
  「本次无法分配 6666 尾号」）、`curve`（总量 10 亿、可售 80%、费率 `tradeFeeBps`、毕业条件）。
- 同一 `Idempotency-Key` + 同一内容 = 同一草稿；同 key 不同内容 `409 IDEMPOTENCY_CONFLICT`。
- 每账号滚动 24 小时最多 `3` 个草稿：`429 RATE_LIMITED`，`detailsSafe = { reasonCode: "MEME_CREATE_RATE_LIMITED", dailyLimit: 3 }`
  → 文案「今天的创建次数用完了，明天再来」。
- `422 VALIDATION_FAILED`：`MEME_METADATA_INVALID`（`detailsSafe.field` = `name|symbol|description|imageMediaId|links|links.twitter|…`）、
  `MEME_IMAGE_NOT_OWNED`。格式明显不对（如小写 symbol、未知字段）在 schema 层就是 `400 INVALID_REQUEST`。
- 尾号盐保留 30 分钟；超时未发起创建会被回收，再准备 create Intent 时换一个（`predictedAddress` 可能变，以 Intent 返回为准）。

## 8. Intent：创建 / 买 / 卖

### 8.1 准备 `POST /v2/meme/tokens/{memeTokenId}/intents`（Idempotency-Key 必填）

```json
{
  "kind": "buy",
  "walletId": "d64786bb-…",
  "usd1Amount": "10",
  "slippageBps": 100,
  "deadlineSeconds": 300
}
```

| kind     | 必填                      | 可选                                                                                           |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `create` | `walletId`                | `usd1Amount`（创建者首买，≥ 1 USD1）、`slippageBps`/`minOut`                                   |
| `buy`    | `walletId`、`usd1Amount`  | `slippageBps`（0–5000，默认 100）或 `minOut`（二选一）、`deadlineSeconds`（30–1800，默认 300） |
| `sell`   | `walletId`、`tokenAmount` | 同上                                                                                           |

`201`：

```json
{
  "memeIntent": {
    "memeIntentId": "dc41735e-f27e-438f-ab4f-9895eca03213",
    "kind": "buy",
    "state": "prepared",
    "memeTokenId": "9ea3…",
    "walletId": "d64786bb-…",
    "chainId": "eip155:97",
    "chainReference": 97,
    "contractAddress": "0xe108d45e3e9d7b8c9c02c5e10544ad811cb39b8a",
    "tokenAddress": "0xac42…ca94",
    "usd1Amount": "10000000000000000000",
    "tokenAmount": "0",
    "expectedOut": "999636100727544464736354",
    "minOut": "989639739720269020088990",
    "fee": "100000000000000000",
    "refund": "0",
    "deadline": "2026-10-08T03:05:00.000Z",
    "expiresAt": "2026-10-08T03:05:00.000Z",
    "createdAt": "2026-10-08T03:00:00.000Z",
    "calldata": { "to": "0xe108…b8a", "data": "0xce9eb517…", "value": "0" },
    "unsignedTransaction": {
      "chainId": 97,
      "to": "0xe108…b8a",
      "data": "0xce9eb517…",
      "value": "0x0",
      "from": "0x…0a",
      "gas": "0x493e0",
      "nonce": "0x8",
      "type": "legacy",
      "maxFeePerGas": null,
      "maxPriorityFeePerGas": null,
      "gasPrice": "0x3b9aca00"
    },
    "approval": {
      "token": "0x17d5…ce2b",
      "spender": "0xe108…b8a",
      "amount": "10000000000000000000",
      "calldata": { "to": "0x17d5…ce2b", "data": "0x095ea7b3…", "value": "0" },
      "unsignedTransaction": {
        "chainId": 97,
        "to": "0x17d5…ce2b",
        "data": "0x095ea7b3…",
        "value": "0x0",
        "from": "0x…0a",
        "gas": "0x13880",
        "nonce": "0x7",
        "type": "legacy",
        "maxFeePerGas": null,
        "maxPriorityFeePerGas": null,
        "gasPrice": "0x3b9aca00"
      }
    },
    "payloadDigest": "eaa764e0…96ca",
    "snapshotBlockNumber": "135600320",
    "snapshotBlockHash": "0x…",
    "transactionHash": null,
    "reasonCode": null,
    "simulation": {
      "status": "unavailable",
      "reasonCode": "MEME_APPROVAL_REQUIRED"
    },
    "policy": {
      "configVersion": "bscWriteCanaryV1",
      "canaryMaxUsd": "20",
      "valueUsd": "10",
      "priceSource": "usd1_par"
    },
    "signing": {
      "mode": "device_eth_send_transaction",
      "allowed": true,
      "reasonCode": null
    }
  },
  "contractVersion": "2.0"
}
```

- create 额外有 `predictedAddress`；`tokenAddress` 为 `null`。
- `approval` 非空 = 授权不足（买/建带首买：USD1 → 曲线；卖：代币 → 曲线），金额**精确**等于本次需要，从不无限授权。

### 8.2 签名流程（`LoopSignSheet`）

1. 签名前展示的字段只取自本对象（`usd1Amount/tokenAmount`、`expectedOut`、`minOut`、`fee`、`refund`、
   `policy.valueUsd`、`deadline`），与 `payloadDigest` 同源。
2. `approval` 非空：先把 `approval.unsignedTransaction` 原样交给 `eth_sendTransaction`（nonce N），**不需要**回报；
   然后签 `unsignedTransaction`（nonce N+1）。此时 `simulation.status = "unavailable"` / `MEME_APPROVAL_REQUIRED`
   是正常的（授权前无法模拟），gas 为固定上限。
3. `approval` 为 `null`：直接签 `unsignedTransaction`。`signing.allowed = false` 时不得签名，按 `signing.reasonCode` 提示：
   `MEME_SIMULATION_REVERTED`（模拟失败，重新报价）、`MEME_INTENT_EXPIRED`（重新准备）。
4. 拿到主交易哈希后调用 §8.3；然后轮询 §8.4。成功 Toast 不代表链上完成，以 `state = confirmed` 为准。
5. `expiresAt` 后未回报 → `state` 读出 `expired`，重新准备（新的 `Idempotency-Key`）。

### 8.3 回报 `POST /v2/meme/tokens/{id}/intents/{memeIntentId}/broadcast-report`（Idempotency-Key 必填）

Body `{ "txHash": "0x…" }`（主交易，不是 approve）。`200` 同 §8.1 形状，`state = "broadcast_reported"`、
`signing.allowed = false`（`MEME_INTENT_ALREADY_REPORTED`）。同一 hash 重复回报原样返回；另一个 hash
`409 DATA_STALE / MEME_INTENT_ALREADY_REPORTED`；已非 `prepared` `409 MEME_INTENT_NOT_SIGNABLE`；
过期且链上看不到 `409 MEME_INTENT_EXPIRED`；链上交易与载荷不符 `422 VALIDATION_FAILED / MEME_TX_PAYLOAD_MISMATCH`。

### 8.4 读取 `GET /v2/meme/intents/{memeIntentId}`

同一投影，仅本人可读（他人/未知 `404`）。建议每 3 秒轮询，直到终态：

| state                | 含义                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `prepared`           | 待签名（过了 `expiresAt` 读出 `expired`）                                                        |
| `broadcast_reported` | 已回报，等待索引或回执                                                                           |
| `confirmed`          | 链上成功（索引到 TokenCreated/Trade 或回执 status 1）。create 成功后代币页 `status` 变 `trading` |
| `failed`             | `reasonCode`：`MEME_TX_REVERTED`（回执失败）、`MEME_TX_PAYLOAD_MISMATCH`                         |
| `expired`            | `MEME_INTENT_EXPIRED`（未回报）或 `MEME_TX_NOT_OBSERVED`（回报后迟迟没有回执）                   |

create 失败（如尾号盐被他人抢用）后代币回到 `draft`，再次准备 create 会自动换盐。

### 8.5 准备阶段的全部拒绝

| HTTP / code                  | detailsSafe.reasonCode                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`        | 字段组合不对（sell 带 usd1Amount、buy 缺 usd1Amount、`minOut` 与 `slippageBps` 同时给、金额为 number）                                                                                                                                            |
| `403 POLICY_BLOCKED`         | `ASSET_NOT_IN_CANARY_ALLOWLIST`、`COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`、`CANARY_CEILING_EXCEEDED`（`exposureUsd`/`ceilingUsd`）、`CANARY_DAILY_CEILING_EXCEEDED`（`remainingUsd` 等）                                                            |
| `404 NOT_FOUND`              | 代币不存在/不可见、钱包不是本人、create 不是创建者                                                                                                                                                                                                |
| `409 DATA_STALE`             | `MEME_CURVE_FULL`、`MEME_CURVE_NOT_TRADING`（+`status`）、`MEME_TOKEN_NOT_DRAFT`、`MEME_TOKEN_NOT_ON_CHAIN`、`MEME_SALT_TAKEN`                                                                                                                    |
| `409 INSUFFICIENT_BALANCE`   | `MEME_USD1_BALANCE_INSUFFICIENT`、`MEME_SELL_EXCEEDS_BALANCE`（+`balance`）、`MEME_GAS_INSUFFICIENT`                                                                                                                                              |
| `409 IDEMPOTENCY_CONFLICT`   | 同 key 不同请求                                                                                                                                                                                                                                   |
| `422 VALIDATION_FAILED`      | `MEME_BELOW_MIN_BUY`（+`minBuyUsd1`）、`MEME_WALLET_CAP_EXCEEDED`（+`walletCapTokens`、`remainingTokens`）、`MEME_QUOTE_ZERO`、`MEME_MIN_OUT_ABOVE_QUOTE`（+`expectedOut`）、`MEME_SELL_EXCEEDS_BALANCE`；无 reasonCode = 钱包不是 Privy 内嵌钱包 |
| `503 CAPABILITY_UNAVAILABLE` | `MEME_WRITES_DISABLED`（后端写开关关）、`MEME_MAINNET_SIGNING_CLOSED`（56 主网签名关闭）、`MEME_CONTRACT_*`（读链失败/合约未核对）、`MEME_REPOSITORY_UNAVAILABLE`                                                                                 |

## 9. 行情段 `GET /v2/market/assets?category=meme`

候选 = App 创建且 `trading/full/graduated` 的 MEME 代币 ∪ 旧 Launch 项目代币。未毕业代币的 `quote` 来自曲线：
`source: "loop_curve"`、`quality: "fresh"`、`change24hPct` 对比 24 小时前、`volume24hUsd` 为钱包侧 USD1；`sparkline`
为 `unavailable` / `MEME_CURVE_SPARKLINE_UNAVAILABLE`。已毕业代币先走 DexScreener；没有报价时（测试网恒如此）
回退读池 `slot0`（决策 0103）：

```json
{
  "priceUsd": "0.0000849",
  "change24hPct": null,
  "marketCapUsd": "84900",
  "volume24hUsd": null,
  "observedAt": "2026-10-08T06:00:00.000Z",
  "source": "pool_slot0",
  "quality": "derived"
}
```

`sparkline` 为 `unavailable` / `MEME_POOL_SPARKLINE_UNAVAILABLE`；读链失败保持原因（测试网 `MARKET_CHAIN_NOT_PRICED`）。
`quote.source` 枚举新增 `loop_curve`、`pool_slot0`，`quote.quality` 新增 `derived`，客户端解码请放宽；`derived`
建议显示「池子推算」标签；`change24hPct` 为 `null` 时涨跌幅显示 `--`。

## 10. 状态与底部交易栏

| `status`        | 底栏                                                        |
| --------------- | ----------------------------------------------------------- |
| `draft`         | 只有创建者可见：「继续创建」                                |
| `pending_chain` | 「创建中…」（轮询 Intent）                                  |
| `trading`       | 「买入」「卖出」                                            |
| `full`          | 「打满，毕业中…」禁用（后端约 15–30 秒内兜底调用 graduate） |
| `graduated`     | 「去兑换」跳 Swap 页并预填代币对                            |
| `paused`        | 「已暂停交易」                                              |

`full → graduated` 由轮询详情得知（`graduation` 非空、`pool` 非空）。兜底执行器在打满后等待
`MEME_GRADUATION_DELAY_SECONDS`（默认 15 秒）再调用，轮询间隔 15 秒，所以打满到毕业通常 15–30 秒加出块确认；
建议 `full` 状态每 3–5 秒轮询一次详情。

## 11. 错误码总表

| reasonCode                                                                                                                                                            | HTTP / code                | 文案建议                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------- |
| `MEME_TOKEN_NOT_FOUND`                                                                                                                                                | 404 NOT_FOUND              | 代币不存在                      |
| `MEME_CURVE_NOT_TRADING` / `MEME_CURVE_FULL`                                                                                                                          | 409 DATA_STALE             | 当前不可交易 / 已打满，等待毕业 |
| `MEME_TOKEN_NOT_DRAFT` / `MEME_TOKEN_NOT_ON_CHAIN`                                                                                                                    | 409 DATA_STALE             | 状态已变化，请刷新              |
| `MEME_SALT_TAKEN`                                                                                                                                                     | 409 DATA_STALE             | 地址已被占用，请重试            |
| `MEME_INTENT_EXPIRED` / `_NOT_SIGNABLE` / `_ALREADY_REPORTED`                                                                                                         | 409 DATA_STALE             | 重新发起                        |
| `MEME_USD1_BALANCE_INSUFFICIENT`                                                                                                                                      | 409 INSUFFICIENT_BALANCE   | USD1 余额不足                   |
| `MEME_SELL_EXCEEDS_BALANCE`                                                                                                                                           | 409 / 422                  | 卖出数量超过持有                |
| `MEME_GAS_INSUFFICIENT`                                                                                                                                               | 409 INSUFFICIENT_BALANCE   | tBNB 手续费不足                 |
| `MEME_WALLET_CAP_EXCEEDED`                                                                                                                                            | 422 VALIDATION_FAILED      | 超过单钱包 4,000 万枚上限       |
| `MEME_BELOW_MIN_BUY`                                                                                                                                                  | 422 VALIDATION_FAILED      | 最少买入 1 USD1                 |
| `MEME_METADATA_INVALID` / `MEME_IMAGE_NOT_OWNED`                                                                                                                      | 422 VALIDATION_FAILED      | 按 `field` 标红                 |
| `MEME_MIN_OUT_ABOVE_QUOTE` / `MEME_QUOTE_ZERO`                                                                                                                        | 422 VALIDATION_FAILED      | 重新报价                        |
| `MEME_TX_PAYLOAD_MISMATCH`                                                                                                                                            | 422 VALIDATION_FAILED      | 交易与确认内容不符              |
| `MEME_CREATE_RATE_LIMITED`                                                                                                                                            | 429 RATE_LIMITED           | 今天的创建次数用完了，明天再来  |
| `MEME_CONTRACT_NOT_CONFIGURED` 等 `MEME_CONTRACT_*`、`MEME_USD1_NOT_CONFIGURED`、`MEME_WRITES_DISABLED`、`MEME_MAINNET_SIGNING_CLOSED`、`MEME_REPOSITORY_UNAVAILABLE` | 503 CAPABILITY_UNAVAILABLE | `LoopInlineUnavailable`         |

状态里的 `reasonCode`（非错误）：`MEME_TX_REVERTED`、`MEME_TX_NOT_OBSERVED`、`MEME_APPROVAL_REQUIRED`、
`MEME_SIMULATION_REVERTED`、`MEME_SIMULATION_UNAVAILABLE`、`MEME_DEX_CHAIN_NOT_PRICED`、`MEME_DEX_QUOTE_UNAVAILABLE`、
`MEME_VIEWER_WALLET_MISSING`。

## 12. 联调环境（dev，BSC 测试网 97）

- 曲线 `0xe108d45e3e9d7b8c9c02c5e10544ad811cb39b8a`，代币实现 `0xa87a54dc67e407e8b6d67e690abdfe02f979f4da`，
  USD1 = MockUSD1 `0x17d554fd27345940e21d1d7328d038bd4049ce2b`（任何人可 mint），合约版本 `1.0.0`。
- App 内单笔金额受 canary 上限约束（dev 当前 `BSC_WRITE_CANARY_MAX_USD`，USD1 按 1 美元）；打满曲线用
  loop-contracts 的 `ops:testnet-meme fill`。
