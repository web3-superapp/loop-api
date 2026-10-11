# 前端交接契约：挖矿奖励（小时结算 · 分钟展示 · Claim）

- 决策：`docs/decisions/0116-mining-hourly-settlement.md`（S138-api）、`docs/decisions/0123-mining-quantity-weighting-and-claim-contract.md`（S147-api：资产轨按数量加权、`claim.executable` 口径、`payloadDigest`）
- 规则来源：`docs/16-挖矿与邀请-中心化结算方案.md`、需求方《LOOP 双轨挖矿开发说明》§6–§9
- 机器契约：`openapi/loop-api.v2.json`（`pnpm openapi:generate` 生成，勿手改）
- 模块：`mining`（`V2_MODULES_ENABLED` 含 `mining`），能力位不新增，看 `GET /v2/meta/capabilities` 的 `mining`

## 1. Base URL 与请求头

| 环境        | Base URL                              |
| ----------- | ------------------------------------- |
| Development | `https://api-dev.quant-dinger.cc`     |
| Staging     | `https://api-staging.quant-dinger.cc` |

所有路由：

```
Authorization: Bearer <Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: <app version>
```

写接口（`POST /v2/mining/claim/prepare`、`POST /v2/mining/claim/report`）另需：

```
Idempotency-Key: <UUIDv4，每次新操作新生成；重试同一操作用同一个>
Content-Type: application/json
```

## 2. 数值约定

- LOOP 金额一律 **原始整数字符串**（字段名以 `Raw` 结尾，18 位小数，响应带 `decimals: 18`）。显示时自己除以 10^18，**不要用浮点累加**（用 BigInt / 定点库）。
- 算力是十进制字符串（最多 18 位小数），只用于展示比例，不参与金额计算。
- 时间是 ISO 8601 UTC。

## 3. `GET /v2/mining/rewards`（已有路由，新增 `hourly` 块）

旧键 `claimable` / `accumulated` / `claimExecutable` / `estimatedToday` / `ledger` / `source` 含义不变（仍为 `REWARD_AUTHORITY_PENDING`，旧页面不受影响）。**新页面只读 `hourly`。**

```json
{
  "claimable": {
    "status": "unavailable",
    "reasonCode": "REWARD_AUTHORITY_PENDING"
  },
  "claimExecutable": false,
  "estimatedToday": { "...": "旧字段，略" },
  "accumulated": {
    "status": "unavailable",
    "reasonCode": "REWARD_AUTHORITY_PENDING"
  },
  "ledger": [],
  "source": {
    "status": "unavailable",
    "reasonCode": "REWARD_AUTHORITY_PENDING"
  },
  "hourly": {
    "serverTime": "2026-10-10T11:20:00.000Z",
    "decimals": 18,
    "displayState": "displaying",
    "reasonCode": null,
    "totals": {
      "settledRaw": "60000000000000000000",
      "claimedRaw": "0",
      "claimableRaw": "60000000000000000000"
    },
    "lastHour": {
      "epochId": "22222222-2222-4222-8222-222222222222",
      "hourStart": "2026-10-10T10:00:00.000Z",
      "hourEnd": "2026-10-10T11:00:00.000Z",
      "settledAt": "2026-10-10T11:02:00.000Z",
      "nftRewardRaw": "60000000000000000000",
      "assetRewardRaw": "0",
      "totalRewardRaw": "60000000000000000000"
    },
    "display": {
      "windowStart": "2026-10-10T11:00:00.000Z",
      "windowEnd": "2026-10-10T12:00:00.000Z",
      "totalRaw": "60000000000000000000",
      "perMinuteRaw": "1000000000000000000",
      "completedMinutes": 20,
      "displayedRaw": "20000000000000000000",
      "nextUpdateAt": "2026-10-10T11:21:00.000Z"
    },
    "tracks": {
      "nft": {
        "realNftCount": "5",
        "selfPower": "10",
        "referralPower": "0",
        "totalPower": "10",
        "networkPower": "10",
        "budgetRaw": "20833333333333333333333",
        "rewardRaw": "60000000000000000000",
        "holdings": [
          {
            "instanceId": "…",
            "communityId": "…",
            "countAtEnd": "5",
            "power": "10"
          }
        ]
      },
      "asset": {
        "selfPower": "0",
        "referralPower": "0",
        "totalPower": "0",
        "networkPower": "0",
        "budgetRaw": "20833333333333333333333",
        "rewardRaw": "0",
        "holdings": [
          {
            "assetId": "eip155:97:0x…6666",
            "balanceAtEndRaw": "1000000000000000000000",
            "power": "1500"
          }
        ],
        "excludedAssets": [
          {
            "assetId": "eip155:97:0x…6666",
            "reasonCode": "MINING_ASSET_GRADUATED_BALANCE_PENDING"
          }
        ]
      }
    },
    "referral": {
      "levels": [
        {
          "level": 1,
          "ratioBps": 1000,
          "effectiveMembers": 1,
          "nftPower": "1",
          "assetPower": "0",
          "totalPower": "1",
          "nftUnitsByCommunity": [{ "communityId": "…", "units": "0.5" }]
        }
      ]
    },
    "parameters": {
      "versionId": "…",
      "configVersion": "miningHourlyV1",
      "effectiveFrom": "2026-10-10T00:00:00.000Z",
      "referralRatiosBps": [1000, 500, 300, 200, 100],
      "minimumClaimRaw": "1000000000000000000"
    },
    "claim": {
      "executable": false,
      "reasonCode": "MINING_CLAIM_SIGNER_NOT_CONFIGURED",
      "latest": null
    }
  },
  "contractVersion": "2.0"
}
```

`referral.levels` 恒为 5 项（L1–L5）。比例来自 `ratioBps`（1000 = 10%），**页面不写死**。

### 3.1 `displayState`

| 值                          | 含义                               | 页面                                                    |
| --------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `awaiting_first_settlement` | 还没有任何已结算小时               | 显示「首个小时结算后开始展示奖励」，不做增长动画        |
| `displaying`                | 当前处于上一小时奖励的展示窗口内   | 按 §3.2 推导分钟进度                                    |
| `settling`                  | 展示窗口已过，下一小时尚未结算完成 | 显示上一小时完整总额 + 「结算中」，不得把估算当成可领取 |
| `unavailable`               | 结算服务不可用（`reasonCode`）     | 显示不可用；`totals`/`display`/`tracks` 为 `null`       |

`reasonCode` 可能：`MINING_SETTLEMENT_UNAVAILABLE`、`MINING_PARAMETERS_PENDING`（尚无审批通过的参数版本）。

> 本例 `executable = false` 只是演示（dev 尚未配置签名人）；`hourly.claim` 的完整口径见 §3.4。

### 3.2 分钟展示推导（前端必须照此实现，不要用计时器累加）

```
offset          = serverTime − 本机收到响应时的时间   （只在每次拉取时校准一次）
now             = 本机时间 + offset
m               = min(60, floor((now − display.windowStart) / 60 秒))，m < 0 时取 0
displayedRaw(m) = m >= 60 ? totalRaw : floor(totalRaw × m / 60)      （BigInt）
下次刷新数字时间 = windowStart + (m + 1) 分钟（m = 60 时不再变化）
now >= windowEnd → 视同 settling：显示 totalRaw，重新拉取接口
```

- 余数自然落在第 60 分钟（`floor` 在最后一分钟补齐），展示总额恰好等于该小时实际奖励。
- 刷新、杀进程、换设备后重新拉取即可恢复同一进度（服务端 `display.completedMinutes` / `displayedRaw` 与上式一致，可直接用于首帧）。
- **展示进度与可领取无关**：Claim 按钮金额只看 `totals.claimableRaw`；不要把动画数值加回可领取，也不要在领取成功后继续给「可领取」做动画。

### 3.3 页面模块与字段（需求方 §8.1）

| 模块      | 字段                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| 奖励汇总  | `totals.settledRaw` 累计已结算、`totals.claimedRaw` 累计已领取、`totals.claimableRaw` 当前可领取                   |
| 分钟增长  | `lastHour.totalRewardRaw`、`display.displayedRaw`（按 §3.2 推导）、`display.nextUpdateAt`                          |
| NFT 轨道  | `tracks.nft.realNftCount`（真实 NFT 数量）、`selfPower`、`referralPower`、`totalPower`、`rewardRaw`                |
| Meme 轨道 | `tracks.asset.holdings`（有效资产明细）、`selfPower`、`referralPower`、`totalPower`、`rewardRaw`、`excludedAssets` |
| 五级邀请  | `referral.levels[]`：`ratioBps`、`effectiveMembers`、`nftPower`、`assetPower`、`totalPower`                        |
| Claim     | `totals.claimableRaw`、`claim.executable`/`claim.reasonCode`、`claim.latest`、`GET /v2/mining/claims`              |

- **Meme 轨道按数量加权，不按估值**（需求方 2026-10-10 裁决，决策 0123）：`holdings[].power` 与 `selfPower`
  = 该小时持币数量的时间加权平均（TWAB）× 后台批准的 Mining Weight，**不乘任何价格**。上例 1000 枚 × 权重 1.5
  = `1500`。字段集合不变（`assetId`、`balanceAtEndRaw`、`power`），从来没有估值 / 价格字段；页面不要显示「估值」「美元」。
  0123 之前已结算的小时保留当时（按估值）的数字，不重算。
- 未在参数里单独设系数的社区，NFT 系数按 1.0 计（0123 起的参数版本）。
- 真实 NFT 数量（`realNftCount`）与等效 NFT 单位（`nftUnitsByCommunity`）**不能合并**展示为「持有 NFT 数量」；等效单位只用于奖励计算，不带来提前购资格或额度。
- 文案用「邀请算力加成」「贡献算力」，不用「收益分成」。
- `tracks` 是上一已结算小时的数字（不是实时持仓）。

### 3.4 `hourly.claim.executable`（决策 0123）

`executable = true` 当且仅当下列全部成立；否则为 `false`，`reasonCode` 取**第一个**不满足的：

| 顺序 | `reasonCode`                                                                                                                                                                     | 条件                                                 | 页面建议                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------- |
| 1    | `MINING_SETTLEMENT_UNAVAILABLE`                                                                                                                                                  | 结算服务不可用                                       | 领取不可用                   |
| 2    | `MINING_PARAMETERS_PENDING`                                                                                                                                                      | 当前没有生效中的已批准参数版本                       | 挖矿规则待生效               |
| 3    | `MINING_NOTHING_SETTLED`（**新**）                                                                                                                                               | 还没有任何已结算小时                                 | 首个小时结算后可领取         |
| 4    | `MINING_CLAIM_NOTHING_TO_CLAIM`                                                                                                                                                  | `totals.claimableRaw = 0`（0123 前这里会给 `true`）  | 暂无可领取                   |
| 5    | `MINING_CLAIM_BELOW_MINIMUM`                                                                                                                                                     | `0 < claimableRaw < parameters.minimumClaimRaw`      | 满 x LOOP 可领取             |
| 6    | `MINING_CLAIM_IN_FLIGHT`                                                                                                                                                         | `claim.latest.status` 是 `submitting` / `confirming` | 显示该笔进度，不再发起新领取 |
| 7    | `MINING_CLAIM_MAINNET_CLOSED`、`MINING_CLAIM_CONTRACT_NOT_CONFIGURED`、`MINING_CLAIM_CHAIN_NOT_CONFIGURED`、`MINING_CLAIM_SIGNER_NOT_CONFIGURED`、`MINING_CLAIM_WRITES_DISABLED` | 服务端领取通道未配置                                 | 领取暂不可用                 |

`executable = true` 只表示「可以去 prepare」；合约暂停、资金不足、gas 不足仍由 prepare 返回（§5.5、§7）。

## 4. `GET /v2/mining/rewards/epochs?cursor=`

本人每个已结算小时一行（无算力的小时没有行），新到旧，每页 24，`nextCursor` 为 `null` 时到底。

```json
{
  "items": [
    {
      "epochId": "…",
      "hourStart": "2026-10-10T10:00:00.000Z",
      "hourEnd": "2026-10-10T11:00:00.000Z",
      "nftSelfPower": "10",
      "nftReferralPower": "0",
      "nftTotalPower": "10",
      "assetSelfPower": "0",
      "assetReferralPower": "0",
      "assetTotalPower": "0",
      "nftRewardRaw": "60000000000000000000",
      "assetRewardRaw": "0",
      "totalRewardRaw": "60000000000000000000"
    }
  ],
  "nextCursor": null,
  "decimals": 18,
  "contractVersion": "2.0"
}
```

## 5. Claim

### 5.1 状态枚举（`claim.status`）

| 值           | 中文（需求方）         | 说明                                                                   |
| ------------ | ---------------------- | ---------------------------------------------------------------------- |
| `claimable`  | 可领取                 | 凭证已签发，等待设备发送交易                                           |
| `submitting` | 提交中                 | 已上报交易哈希，链上还查不到                                           |
| `confirming` | 链上确认中             | 已上链，确认数不足                                                     |
| `succeeded`  | 成功                   | 确认完成，`amountRaw` = 链上 `Claimed` 事件的金额，账本已更新          |
| `failed`     | 失败                   | 交易回滚（`failureReasonCode: MINING_CLAIM_REVERTED`），可领取余额不变 |
| `expired`    | （失效，按可领取处理） | 截止时间已过且未上链，或同一 nonce 的另一张凭证已上链；余额不变        |

### 5.2 `POST /v2/mining/claim/prepare`

请求：

```json
{ "walletId": "d64786bb-408d-415d-8a69-6277d56c921b" }
```

`201` 响应：

```json
{
  "claim": {
    "claimId": "…",
    "walletId": "d64786bb-…",
    "status": "claimable",
    "chainId": "eip155:97",
    "chainReference": 97,
    "contractAddress": "0x…",
    "cumulativeAmountRaw": "60000000000000000000",
    "amountRaw": "60000000000000000000",
    "nonce": "0",
    "deadline": "2026-10-10T11:30:00.000Z",
    "transactionHash": null,
    "blockNumber": null,
    "failureReasonCode": null,
    "createdAt": "…",
    "updatedAt": "…"
  },
  "intent": {
    "calldata": { "to": "0x…", "data": "0x…", "value": "0" },
    "unsignedTransaction": {
      "chainId": 97,
      "to": "0x…",
      "from": "0x…",
      "data": "0x…",
      "value": "0x0",
      "gas": "0x…",
      "nonce": "0x7",
      "type": "legacy",
      "gasPrice": "0x…",
      "maxFeePerGas": null,
      "maxPriorityFeePerGas": null
    },
    "payloadDigest": "0x…64位hex",
    "signing": {
      "mode": "device_eth_send_transaction",
      "allowed": true,
      "reasonCode": null
    }
  },
  "decimals": 18,
  "contractVersion": "2.0"
}
```

- 设备把 `unsignedTransaction` **原样**交给 Privy `eth_sendTransaction`（与 launch2 / meme 的签名出口相同），拿到 hash 后立即调用 §5.3。
- `intent` 恰好四个键：`calldata`、`unsignedTransaction`、`payloadDigest`、`signing`（决策 0123 新增 `payloadDigest`）。
- `unsignedTransaction` **恰好 11 个键**（OpenAPI `additionalProperties: false`）：`chainId`（整数 56 / 97）、`to`、`data`、
  `value`（恒 `"0x0"`）、`from`、`gas`、`nonce`、`type`（`eip1559` | `legacy`）、`maxFeePerGas`、`maxPriorityFeePerGas`、
  `gasPrice`。费用键随 `type`：`eip1559` → 两个 `max*` 有值、`gasPrice = null`；`legacy` → `gasPrice` 有值、两个 `max*` 为 `null`。
  多键或少键都应视为非法载荷。
- `payloadDigest` 定义：`"0x" + hex(keccak256(utf8(canonicalJson(unsignedTransaction))))`，其中 canonicalJson = 键按码元
  升序、无空白、`chainId` 是 JSON 数字、`null` 原样保留（与 0141 codec 的 `localDigest` 同一算法，只多 `0x` 前缀）。
  客户端用将要交给钱包的那份 `unsignedTransaction` 自算一次，与 `payloadDigest` 不一致时不得签名。
- 金额（`amountRaw`）= 已完成小时累计结算 − 链上已领取；**当前未结束的小时不在其中**。前端不传金额。
- 每次点击都会签一张新凭证（10 分钟有效）；旧凭证在任意一笔领取上链后因 nonce 失效。同一 `Idempotency-Key` 重放返回同一张凭证（重复点击不会生成多张）。
- `signing.allowed = false`（`reasonCode: MINING_CLAIM_EXPIRED`）时不要发送，重新 prepare。

### 5.3 `POST /v2/mining/claim/report`

```json
{ "claimId": "…", "transactionHash": "0x…64位hex" }
```

`200` → `{ "claim": {…同上…}, "decimals": 18, "contractVersion": "2.0" }`。

- `submitting` / `confirming`：每 3–5 秒用**新的** `Idempotency-Key` 再报同一 hash，直到 `succeeded` / `failed`（后台也会自动跟进，App 退出后仍会对账）。
- 同一 hash 重复上报幂等，账本只记一次。
- **已广播但结果未知时不要重新 prepare 再发**：先反复 report 同一 hash；只有 `failed` / `expired` 后才可再次领取。

### 5.4 `GET /v2/mining/claims?cursor=`

`{ "items": [claim…], "nextCursor": null, "decimals": 18, "contractVersion": "2.0" }`，新到旧，每页 20。

### 5.5 无 BNB 付 gas（需求方 §5.5 裁决）

prepare 返回 `409 INSUFFICIENT_BALANCE`：

- `reasonCode: CLAIM_GAS_INSUFFICIENT`：钱包有 USDT，`detailsSafe` 带
  `requiredNativeAmount`（本次需要的 BNB，十进制）、`suggestedSwapFromSymbol: "USDT"`、`suggestedSwapFromAssetId`、`suggestedSwapToSymbol: "BNB"`、`suggestedSwapToAssetId: "eip155:97:native"`、`suggestedSwapToAmount`（建议换到的 BNB，含 50% 余量）。页面显示「余额不足 → 一键去兑换」，跳转兑换页并预填 USDT→BNB；现阶段 `privySwap` 只能报价不能执行，自动兑换等其开放后接上。
- `reasonCode: CLAIM_NO_GAS_SOURCE`：BNB 与 USDT 都没有，只提示充值，`detailsSafe.requiredNativeAmount`。

## 6. 错误

错误体固定七个字段：`code / category / retryable / userMessageKey / correlationId / detailsSafe / providerReferenceSafe`，原因看 `detailsSafe.reasonCode`。

| HTTP | `code`                           | `reasonCode`                                                                                                                                   | 场景                                                |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | —                                                                                                                                              | 请求体 / cursor 非法                                |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                                              | Bearer 缺失或失效                                   |
| 404  | `NOT_FOUND`                      | `MINING_CLAIM_NOT_FOUND`（report）；无 reasonCode = walletId 不属于本人                                                                        |                                                     |
| 409  | `INSUFFICIENT_BALANCE`           | `MINING_CLAIM_NOTHING_TO_CLAIM`、`MINING_CLAIM_BELOW_MINIMUM`（`minimumRaw`, `claimableRaw`）、`CLAIM_GAS_INSUFFICIENT`、`CLAIM_NO_GAS_SOURCE` | prepare                                             |
| 409  | `RESOURCE_CONFLICT`              | `MINING_CLAIM_IN_FLIGHT`（`claimId`）、`MINING_CLAIM_LEDGER_MISMATCH`、`MINING_CLAIM_TRANSACTION_CONFLICT`                                     | 已有领取在途 / 账本与链上不一致 / 同一领取换了 hash |
| 409  | `SIMULATION_FAILED`              | `MINING_CLAIM_SIMULATION_REVERTED`                                                                                                             | 合约模拟回滚（如日上限）                            |
| 409  | `DATA_STALE`                     | `MINING_CLAIM_TRANSACTION_MISMATCH`                                                                                                            | 上报的交易不是这张凭证的领取                        |
| 409  | `IDEMPOTENCY_CONFLICT`           | —                                                                                                                                              | 同一 key 用于不同请求体                             |
| 422  | `VALIDATION_FAILED`              | `MINING_CLAIM_WALLET_NOT_EMBEDDED`                                                                                                             | 只支持内嵌钱包                                      |
| 503  | `CAPABILITY_UNAVAILABLE`         | 见 §7                                                                                                                                          |                                                     |

## 7. 不可用行为（fail closed）

| `reasonCode`                           | 原因                          | 影响                                                  |
| -------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| `MINING_SETTLEMENT_UNAVAILABLE`        | 结算库不可用                  | `hourly.displayState = unavailable`；列表 / Claim 503 |
| `MINING_PARAMETERS_PENDING`            | 尚无审批通过的参数版本        | `awaiting_first_settlement`，无奖励                   |
| `MINING_NOTHING_SETTLED`               | 还没有已结算小时              | `hourly.claim.executable=false`（§3.4）               |
| `MINING_CLAIM_CONTRACT_NOT_CONFIGURED` | 未配置 `LoopRewardClaim` 地址 | Claim 503，`hourly.claim.executable=false`            |
| `MINING_CLAIM_CHAIN_NOT_CONFIGURED`    | 无 launch slot RPC            | 同上                                                  |
| `MINING_CLAIM_SIGNER_NOT_CONFIGURED`   | 未配置凭证签名人              | 同上                                                  |
| `MINING_CLAIM_WRITES_DISABLED`         | `BSC_WRITES_ENABLED` 关闭     | 同上                                                  |
| `MINING_CLAIM_MAINNET_CLOSED`          | launch slot 是 BSC 主网       | 同上                                                  |
| `MINING_CLAIM_CONTRACT_PAUSED`         | 合约暂停                      | prepare 503                                           |
| `MINING_CLAIM_FUNDING_INSUFFICIENT`    | 合约余额不足本次领取          | prepare 503                                           |
| `MINING_CLAIM_CHAIN_READ_FAILED`       | RPC 读取失败                  | prepare / report 503，可重试                          |

`hourly.claim.executable = false` 时把 Claim 按钮置灰并显示 `hourly.claim.reasonCode`；可领取余额照常显示。

## 8. S148 变更（决策 0125）

Base URL、请求头、错误体与 §1、§6 相同；**没有新增或删除任何字段**（0141 codec 的键集合不变），只改变值的口径。

### 8.1 `hourly.displayState` 按本人首个结算小时判定（S138 观察 ②）

- 以前：只要全网有已结算小时就是 `displaying` / `settling`，没有奖励行的新用户看到 `displaying` + 0。
- 现在：调用者**本人**还没有任何一个「有算力（两轨任一 > 0）或有奖励」的已结算小时时，
  `displayState = "awaiting_first_settlement"`，且 `lastHour = null`、`display = null`、`tracks = null`；
  `totals` 照常返回（全 0）；`referral.levels` 照常返回（比例来自参数）；`reasonCode` 为 `null`（有生效参数时）。
- 同时 `hourly.claim` 为 `{executable: false, reasonCode: "MINING_NOTHING_SETTLED"}`（§3.4 第 3 条的口径也改为「本人」）。
- 页面：沿用现有 `awaiting_first_settlement` 文案「首个小时结算后开始展示奖励」，不做增长动画。

### 8.2 合约暂停时不可领取（S138 D3）

§3.4 的顺序表在第 7 条（服务端配置）之后追加：

| 顺序 | `reasonCode`                     | 条件                                                   | 页面建议（App 已有中文）   |
| ---- | -------------------------------- | ------------------------------------------------------ | -------------------------- |
| 8    | `MINING_CLAIM_CONTRACT_PAUSED`   | 前 7 条都满足，链上 `LoopRewardClaim.paused()` 为 true | 领取合约已暂停，暂不能领取 |
| 8    | `MINING_CLAIM_CHAIN_READ_FAILED` | 前 7 条都满足，但读合约失败（RPC 不可用）              | 领取暂不可用（通用文案）   |

- 原因码沿用 prepare 已有的 `MINING_CLAIM_CONTRACT_PAUSED`（App 的 `miningClaimUnavailableText` 已映射），没有新造
  `CLAIM_CONTRACT_PAUSED`。
- 只有前 7 条都满足时才读链，`GET /v2/mining/rewards` 不因链不可用而失败。

### 8.3 `GET /v2/mining/rewards/epochs` 不再返回零算力小时（S138 D2）

两轨 `*TotalPower` 都为 0 且 `totalRewardRaw = 0` 的小时不出现在列表里（与 §4 的「无算力的小时没有行」一致）。
翻页游标不变。

### 8.4 毕业后的资产轨

launch2 MEME 毕业后不再整段为 0：后端索引 MEME 的 ERC-20 `Transfer`，毕业后的持币数量按链上余额的小时 TWAB × 权重计算。
`tracks.asset.excludedAssets` 的原因码（决策 0126，字段不变）：

| reasonCode                               | 何时出现                                                                                           | App 文案（建议）                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| `MINING_ASSET_GRADUATED_BALANCE_PENDING` | 新：数量口径的小时里，该 MEME 已毕业但毕业后的余额追踪（MEME `Transfer` 覆盖）尚未完成。不涉及价格 | 「已毕业，外盘持有数量同步中」   |
| `MINING_ASSET_GRADUATED_UNREADABLE`      | 旧：只剩 0123 之前按估值（价格）结算、被重放的小时                                                 | 「已毕业，外盘持有数量暂读不到」 |

覆盖完成后的小时不再列出该资产。0126 之前已结算、库里存的是旧码的数量口径小时，接口按新码返回（结算摘要不改写，不进 digest）。
未知原因码按「暂不计入」兜底。
