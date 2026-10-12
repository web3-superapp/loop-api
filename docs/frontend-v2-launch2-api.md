# Frontend contract: MEME v2 (`launch2`) — Decision 0114 (+ 0117, 0118, 0121, 0122, 0124, 0126, 0127)

> **S151 / 决策 0127 变化（给 App）**：`instance.pool` 新增三个**必带**键 `userTradeCount` /
> `userBuyVolumeUsd1` / `userSellVolumeUsd1`（§3.10）：与 `tradeCount` / `buyVolumeUsd1` / `sellVolumeUsd1`
> 同口径，但**剔除本实例回购适配器 / 执行器发起的池内成交**（即外盘市场成交）。原字段含义不变（仍含回购）。
> 「外盘成交 N 笔 / 外盘买入 / 卖出量」请改用 `user*`；`tradeCount - userTradeCount` = 已索引的回购成交笔数。
> **部署顺序**：严格解码器会拒绝未知键的旧包，须先发能接受这三个键的包，再上这一版 API。

> **S150 / 决策 0126 变化（给 App）**：① **签名有效期**：报价（`…/quote`、`…/pool/quote`）的 `deadline` /
> `expiresAt` 仍是 60 s 新鲜度；prepare 返回的意图 `deadline` / `expiresAt`（以及编码进合约调用的 deadline）
> 改为 **prepare 时刻 + 180 s**（服务端 `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS`，默认 180），外盘 prepare 在该
> 区块重新模拟（`quote.basis` 是 prepare 区块）。App 以意图的 `expiresAt` 判断能否继续签第二笔（授权后签交易），
> 不要再用报价的 60 s。② **持仓余额**：详情 `viewer` 与 `GET /v2/launch2/me/positions` 每行新增
> `memeBalance` / `usd1Balance` / `balanceStatus` / `balanceReasonCode` / `balanceBlockNumber`（毕业后链读，
> ≤ 15 s 缓存；毕业前为 `null` + `not_graduated`）。③ **自己的外盘成交**：新增
> `GET …/pool/trades?walletId=&limit=`（§3.11），`viewer` 与 positions 新增 `poolTradeCount` /
> `lastPoolTradeAt`——成交确认请看自己的 `poolTradeCount` 增加，**不要**再看全池 `pool.tradeCount`。只在外盘交易
> 过（没有内盘 / NFT）的钱包现在也出现在 positions 里。**严格解码的客户端必须加上这 7 个 key。**

> **S146 / 决策 0124 变化（给 App）**：毕业（`stage = graduated`）后在页内买卖外盘（Uniswap v4 官方池，经
> `OfficialPoolRouter`）。新增 `GET …/pool/quote` 与 `POST …/pool/trade/prepare`（§3.8、§3.9），详情新增
> `instance.pool`（§3.10，毕业前为 `null`）。外盘税 2 % 从**输出**扣（买：扣 MEME；卖：扣 USD1），与内盘
> 10 % 不同。新意图种类 `pool_buy` / `pool_sell`。曲线的 `…/quote`、`…/trade/prepare` 对毕业实例仍是
> `409 LAUNCH2_SOLD_OUT`，毕业后的交易面板改走 pool 路由。

> **S145 / 决策 0122 变化（给 App）**：① 第三版工厂（BSC 测试网 `0xc3ac…d1d2`）的回购**没有价格保护**；
> `GET …/buybacks` 的 `minMemeOut / referencePriceUsd1 / spotPriceUsd1` 可为 `null`（新工厂的成交），
> `live.nextOrderBlockedReason` 重定义（§3.6；`BUYBACK_PROTECTION_BLOCKED` 不再出现）。② **NFT 一个都没卖出
> 时不再关闭**：新工厂实例直接进 `public`，`snapshot.status = "opened_without_holders"`，新增
> `snapshot.openedWithoutHolders`（§2、§3.2）；`closed_no_holders` 只可能出现在旧工厂实例上（deprecated，
> 保留一个版本）。③ keeper 拒绝原因去掉价格保护类（只剩旧工厂实例会出现，§3.2）。

Status: implemented on `feat/S134-launch2-read-model`, follow-ups in `fix/S139-launch2-followups`
(Decision 0117); Development / BSC Testnet (chain 97) only. Evidence: anvil end-to-end
(`test/launch2-anvil.integration.test.ts`); BSC Testnet round 1 (S137) reached `upcoming`
with the read model matching the chain 40/40; NFT mint and later stages not yet run. Project-side flow (资料 → 审核 → 签名 → 部署 → 激活) stays on the S125 routes
(`docs/frontend-v2-hooks-launch-api.md`).

## 1. Base URL, headers, capability

- Base URL: the API origin (`https://api-dev.quant-dinger.cc` in Development).
- Every request: `Authorization: Bearer <Privy access token>`, `X-Loop-Client-Version`,
  `X-Loop-Contract-Version: 2.0`.
- `POST` additionally: `Idempotency-Key: <UUIDv4>` (a new UUID per user action; the same key
  with the same body returns the same Intent; another body → `409 IDEMPOTENCY_CONFLICT`).
- Show the MEME v2 entry only when `GET /v2/meta/capabilities` has
  `{capabilityId: "launch2", availability: "available"}`. `deferred` = module off;
  `unavailable` = `reasonCode` names what is missing. Evidence stays `pending`.
- Amounts are decimal strings, 18 decimals max (USD1 and MEME), never JSON numbers; block
  numbers and counters are integer strings; times are ISO-8601 UTC.

## 2. Stages (服务端唯一真相)

| `stage`             | Meaning                                                                           | `nextChangeAt` | App                            |
| ------------------- | --------------------------------------------------------------------------------- | -------------- | ------------------------------ |
| `upcoming`          | Activated, NFT sale not open yet                                                  | sale start     | 即将开售 · 倒计时              |
| `nft_sale`          | NFT sale until `nftSale.endAt`                                                    | sale end       | NFT 发售中 · 剩余 d h m        |
| `snapshot_pending`  | Sale over, holder list not published                                              | `null`         | 名单生成中                     |
| `closed_no_holders` | **Deprecated (0122)**: old-Factory sale with no NFT holder (0120)                 | `null`         | 已结束 · 无人参与 NFT 发售     |
| `priority`          | Snapshot holders only, 3,600 s                                                    | round end      | 提前购 · 持有人优先 · 剩余 m s |
| `public`            | Public curve until sold out (0122: also straight after a sale with no NFT minted) | `null`         | 公开内盘                       |
| `graduated`         | Sold out → official pool (either round)                                           | `null`         | 已毕业 · 官方池交易中          |
| `paused`            | Integrity hold (`holdReason`)                                                     | `null`         | 已暂停 + reason                |

**NFT 发售期（S141 / 决策 0119）**：发售结束时刻由实例的 `nftSale.endAt` 决定（= 该实例
`ProjectNFT.saleEnd()`，部署核验时读链得到），**不是**模板常量 7 天。BSC 测试网工厂为
**1 小时**（`endAt − startAt = 3600 s`，`template.nftSaleSeconds = 3600`）；主网为 7 天
（604800）。倒计时一律以 `nftSale.endAt` / `nextChangeAt` 为准，「剩余 d h m」在 1 小时期间
应显示为「剩余 m s」；不要写死「7 天」文案，时长展示用 `template.nftSaleSeconds`。

**无人认购直接进公开内盘（S145 / 决策 0122，需求方答复 10）**：第三版工厂起，NFT 发售结束时一个都没卖出，
服务端发布器在截止块确认、索引器追上、链上 `totalMinted() = 0` 后代调 `SnapshotRegistry.openPublicWithoutSnapshot()`
（先写记录再广播，12 确认）；索引到 `PublicRoundOpenedWithoutHolders` 后实例直接为 `public`：没有提前购、
无需 proof、可买可卖。期间（发售结束 → 事件确认，测试网约 1 分钟）阶段仍是 `snapshot_pending`。
详情 `snapshot.status = "opened_without_holders"`、`snapshot.openedWithoutHolders` 非 null、`snapshot.publication = null`、
`snapshot.closure = null`，`earlyRoundEndsAt = openedAt`。App 显示「公开内盘 · 无提前购」即可，不要显示「名单」。

**`closed_no_holders`（S142 / 决策 0120，终态；0122 起 deprecated，只会出现在第二版及更早工厂的实例上——旧合约没有
零持有人开盘函数）**：NFT 发售结束时一个 NFT 都没卖出（发布器在已确认的
截止块上读到 `ProjectNFT.totalMinted() = 0`，且索引器已追上）。合约要求名单根非零，所以名单永远无法
发布、提前购和公开内盘都不会开始；`snapshot.closure` 非 null（见 §3.2），报价 / 交易准备一律
`409 LAUNCH2_STAGE_MISMATCH`（`detailsSafe.stage = "closed_no_holders"`）。旧 App 不认识该值时应按
未知阶段降级（灰态 + 「已结束」），不要当成 `snapshot_pending` 一直显示「名单生成中」。列表
`?stage=closed_no_holders` 可筛选。

Poll the detail and count down to `nextChangeAt`; never advance the stage locally. `priority`
and `public` can jump straight to `graduated`. `holdReason`:
`LAUNCH2_DEPLOYED_EVENT_MISMATCH` | `LAUNCH2_ACTIVATION_MISSING`. The buyback pause is
`buyback.paused` (does not grey out the page).

## 3. Routes

### 3.1 `GET /v2/launch2/instances?stage=&limit=|cursor=`

`stage` one of §2; `limit` ≤ 50 (default 30) and `cursor` are mutually exclusive.

```json
{
  "instances": [
    {
      "instanceId": "8b9f3c1e-2d4a-4f6b-9c8d-1e2f3a4b5c6d",
      "projectId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "launchId": "0x5d1c…(32 bytes)",
      "chainId": "eip155:97",
      "name": "Frog Launch",
      "ticker": "FROG",
      "logoUrl": "https://example.com/frog.png",
      "memeAddress": "0xaaaa…6666",
      "stage": "nft_sale",
      "nextChangeAt": "2027-01-16T08:00:00.000Z",
      "holdReason": null,
      "activatedAt": "2027-01-15T07:00:00.000Z",
      "nftSale": {
        "priceUsd1": "100",
        "soldCount": "2",
        "startAt": "2027-01-16T07:00:00.000Z",
        "endAt": "2027-01-16T08:00:00.000Z"
      },
      "curve": {
        "saleSupply": "800000000",
        "soldSupply": "0",
        "soldBps": 0,
        "reserveUsd1": "0",
        "graduationReserveUsd1": "133333.332",
        "reserveBps": 0,
        "priceUsd1": "0.00004166666625"
      },
      "graduatedAt": null
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

List row: 内盘进度 = `curve.soldBps` (已售 / 8 亿), 毕业进度 = `curve.reserveBps`
(储备 / 133,333.332), 当前价 = `curve.priceUsd1`. 起始价（`soldSupply` = 0）=
`0.00004166666625` USD1（CurveMath `priceAt(0)`；S137 测试网与链上对拍一致，决策 0117 更正了
此前文档的笔误 `0.000041666666625`）。

### 3.2 `GET /v2/launch2/instances/{instanceId}?walletId=`

`walletId` optional (default: the active wallet; `viewer` null without one). Adds to the row:

```json
{
  "instance": {
    "…row fields…": "",
    "viewerIsProjectOwner": false,
    "projectOwnerAddress": "0x7777…",
    "configVersion": 1,
    "configHash": "0x2222…",
    "buybackRecipient": "0x28816c4c4792467390c90e5b426f198570e29307",
    "template": {
      "templateVersion": "hooks_launch_v1",
      "memeTotalSupply": "1000000000",
      "curveSaleSupply": "800000000",
      "initialLiquiditySupply": "200000000",
      "graduationReserveUsd1": "133333.332",
      "curveBuyTaxBps": 1000,
      "curveSellTaxBps": 1000,
      "officialPoolTaxBps": 200,
      "lpFee": 2500,
      "tickSpacing": 60,
      "perAddressCap": "5000000",
      "perAddressCapBps": 50,
      "nftPriceUsd1": "100",
      "nftSaleSeconds": 3600,
      "earlyRoundSeconds": 3600,
      "buybackOrderUsd1": "100",
      "buybackMinIntervalSeconds": 10
    },
    "contracts": {
      "factory": "0x…",
      "meme": "0x…6666",
      "hook": "0x…",
      "nft": "0x…",
      "curve": "0x…",
      "gate": "0x…",
      "escrow": "0x…",
      "snapshots": "0x…",
      "graduationAdapter": "0x…",
      "buybackAdapter": "0x…",
      "priceRecorder": "0x…",
      "buybackExecutor": "0x…"
    },
    "snapshot": {
      "status": "published",
      "verification": "verified",
      "root": "0x…",
      "dataHash": "0x…",
      "cutoffBlockNumber": "1234",
      "cutoffBlockHash": "0x…",
      "publishedAt": "2027-01-23T07:05:00.000Z",
      "earlyRoundEndsAt": "2027-01-23T08:05:00.000Z",
      "memberCount": 160,
      "signers": ["0x…", "0x…"],
      "publication": {
        "status": "confirmed",
        "txHash": "0x…",
        "cutoffBlock": "1234",
        "memberCount": 160
      },
      "closure": null
    },
    "graduation": null,
    "buyback": {
      "recipient": "0x2881…9307",
      "paused": false,
      "executedCount": "0",
      "totalUsd1": "0",
      "totalMeme": "0",
      "lastExecutedAt": null,
      "escrowRecordedUsd1": "200",
      "escrowAvailableUsd1": "200",
      "latest": null,
      "keeper": null
    },
    "recentTrades": [
      {
        "tradeId": "…",
        "side": "buy",
        "traderAddress": "0x…",
        "memeAmount": "1125000.5",
        "usd1Gross": "50",
        "usd1Net": "45",
        "taxUsd1": "5",
        "tradedAt": "…",
        "transactionHash": "0x…",
        "blockNumber": "1300"
      }
    ],
    "viewer": {
      "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
      "nft": { "mintedTokenId": "1", "held": 1 },
      "snapshot": { "member": true, "eligibleNow": true },
      "curve": {
        "bought": "1000",
        "sold": "0",
        "net": "1000",
        "cumulativeBought": "1000",
        "remainingQuota": "4999000",
        "usd1Spent": "1.1",
        "usd1Received": "0",
        "taxUsd1": "0.11"
      }
    },
    "projectedAt": "…"
  },
  "contractVersion": "2.0"
}
```

`snapshot.verification`: `null` (not published) | `pending` (lane not done) | `verified` |
`mismatch` (the published root is not the cutoff holders' tree — priority buys are
refused with 503 until an operator resolves it).

`snapshot.publication` (Decision 0118, added; no existing key changed): the latest
server-side 2-of-3 publication attempt, or `null` until the publisher started one.
`{status, txHash, cutoffBlock, memberCount}`; `status` is `pending` (attestation
recorded, transaction not yet sent) | `broadcast` (sent, waiting for confirmations) |
`confirmed` (the `publishSnapshot` transaction is final) | `failed` (refused by the
contract or not sendable; an operator acts) | `mismatch` (another root is on chain, or
the lane did not reproduce it). `txHash` is null while `pending` before signing and
for a contract-refused attempt. Display rule for 名单生成中 (`stage =
snapshot_pending`): `publication = null` → 等待截止块确认; `pending | broadcast` →
名单发布中; `confirmed` with `snapshot.status = pending` → 名单已上链，同步中;
`failed | mismatch` → 名单发布异常，平台处理中. The priority hour starts only from
`snapshot.publishedAt` (unchanged); a `confirmed` publication alone does not open
buying — wait for `stage = priority` and `snapshot.verification = verified`.

`snapshot.openedWithoutHolders` (Decision 0122, added; optional in the schema, always present in
answers): `null`, or `{"openedAt": "…", "blockNumber": "4567", "transactionHash": "0x…"}` after the
indexed `PublicRoundOpenedWithoutHolders` (v3 Factory, no NFT minted). Then `snapshot.status =
"opened_without_holders"`, `root / dataHash / cutoffBlockNumber / cutoffBlockHash / publishedAt /
memberCount / signers / verification / publication / closure` are `null`, `earlyRoundEndsAt =
openedAt`, stage `public`. `viewer.snapshot.member = false`, `eligibleNow = true`.

`snapshot.closure` (Decision 0120, required key, added; **deprecated** by Decision 0122 — only
instances of a pre-S144 Factory can still get one): `null`, or
`{"reason": "no_holders", "cutoffBlock": "1234", "closedAt": "…"}` when the sale ended with no
NFT holder (stage `closed_no_holders`, terminal). With a closure, `snapshot.status` stays
`pending` and `publication` stays `null`; show 已结束 · 无人参与 NFT 发售, no spinner. `graduation` once graduated:
`{graduatedAt, officialPoolId, hookAddress, lpFee: 2500, tickSpacing: 60,
officialPoolTaxBps: 200, transactionHash}` (v4 pools have an id, not an address).

`buyback.keeper` (Decision 0121, S143, added; optional in the schema, always present in
answers; no existing key changed): the server-side buyback keeper's newest attempt, or
`null` before the keeper ever looked at this instance (keeper off, not graduated, or
never eligible). Also in `GET …/buybacks` → `summary.keeper`.

```json
"keeper": {
  "lastAttemptAt": "2027-01-24T08:00:15.000Z",
  "lastResult": "rejected",
  "reasonCode": "LAUNCH2_BUYBACK_PRINCIPAL_INSUFFICIENT",
  "nextEligibleAt": "2027-01-24T08:00:45.000Z"
}
```

| `lastResult` | meaning                                                                                  | 回购面板「最近一笔」                           |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `rejected`   | the contract refused the simulation; nothing was sent; `reasonCode` says why             | 「回购暂缓：<原因>」 + `nextEligibleAt` 倒计时 |
| `pending`    | the order passed simulation and is being signed / sent                                   | 「回购进行中」                                 |
| `broadcast`  | sent, waiting for confirmations                                                          | 「回购进行中」                                 |
| `confirmed`  | final on chain; the ledger row (`latest`) follows from the event lane                    | show `latest` (100 USD1 / 时间)                |
| `failed`     | prepared or sent but not executed (gas, funds, reverted); retried after `nextEligibleAt` | 「回购暂缓，稍后重试」                         |

`reasonCode` for `rejected` (Decision 0122: the v3 Factory has no price protection):
`LAUNCH2_BUYBACK_PRINCIPAL_INSUFFICIENT` (池子本金保护：官方池 USD1 本金 < 10,000 或单笔 > 1%),
`LAUNCH2_BUYBACK_TOO_SOON` (两笔成功间隔 < 10 s), `LAUNCH2_BUYBACK_NO_BUDGET` (托管余额为 0),
`LAUNCH2_BUYBACK_PAUSED` (回购已暂停), `LAUNCH2_BUYBACK_NOT_KEEPER`, `LAUNCH2_BUYBACK_NOT_GRADUATED`,
`LAUNCH2_BUYBACK_NO_OUTPUT` (0122: 成交到账为 0，平台处理), `LAUNCH2_BUYBACK_CONTRACT_REVERTED`
(其它，平台处理). Only instances of a pre-S144 Factory can still show the legacy protection codes
`LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE` (参考价未就绪), `LAUNCH2_BUYBACK_SPOT_OUTSIDE_PROTECTION`,
`LAUNCH2_BUYBACK_OUTPUT_BELOW_PROTECTION` (show them as 「回购暂缓」). For
`failed`: `LAUNCH2_BUYBACK_TX_REVERTED`, `LAUNCH2_BUYBACK_TX_DROPPED`,
`LAUNCH2_BUYBACK_TX_REJECTED`, `LAUNCH2_BUYBACK_GAS_ABOVE_CAP`,
`LAUNCH2_BUYBACK_KEEPER_INSUFFICIENT_FUNDS`, `LAUNCH2_BUYBACK_NONCE_CONSUMED`,
`LAUNCH2_BUYBACK_PAUSED` (paused before sending). Unknown codes → 「回购暂缓」. A refusal
that persists keeps one `rejected` row (the time moves, the code stays); `nextEligibleAt`
doubles from 15 s up to 10 min. `nextEligibleAt` after `confirmed` = the last ledger success

- 10 s; `null` while `pending` / `broadcast`. The keeper is advisory: counts, totals and
  `latest` come only from the ledger (the `BuybackCompleted` events). `paused: true` →
  「回购已暂停」 regardless of `keeper`.

### 3.3 `GET /v2/launch2/instances/{instanceId}/quote?side=buy|sell&amount=&walletId=&slippageBps=`

`amount`: buy = USD1 in (tax included); sell = MEME in. `slippageBps` 0–5000 (default 100).

**Only tradable stages are quoted** (Decision 0117 clarification, S137 measured). A buy quote
exists in `priority` and `public`; a sell quote only in `public`. Every other stage is a 409,
never a 200 with `limitedBy: "closed"`:

| stage                                                                  | quote answer                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `upcoming`, `nft_sale`, `snapshot_pending`, `closed_no_holders` (0120) | `409 DATA_STALE` / `LAUNCH2_STAGE_MISMATCH`, `detailsSafe.stage` = the stage |
| `priority` (sell)                                                      | `409 DATA_STALE` / `LAUNCH2_SELL_NOT_OPEN`, `detailsSafe.stage: "priority"`  |
| `graduated`                                                            | `409 DATA_STALE` / `LAUNCH2_SOLD_OUT`                                        |
| `paused`                                                               | `409 DATA_STALE` / `LAUNCH2_INSTANCE_PAUSED` (`holdReason`)                  |

The App does not call quote outside `priority` / `public` (hide the trade panel, show the
stage countdown); if it does, treat the 409 as "not open yet" and keep polling the detail.

**Stage = the instance detail's stage** (S143, Decision 0121 §quote; closes S137 report
observation 1). The quote and `trade/prepare` judge the stage exactly as `GET
…/instances/{id}` does (the read model: lane-confirmed snapshot / graduation + the clock).
When the chain at the quote block is already in another stage — the snapshot or the
graduation is on chain but not yet `confirmations` deep for the lane (≈ 20 s on the testnet)
— the answer is `409 DATA_STALE` / `LAUNCH2_STAGE_MISMATCH` with `detailsSafe.stage` = the
read-model stage (the same value the detail shows), never a 200 for a round the App does not
show yet. Handle it like the table above: keep the panel in the detail's stage and poll the
detail; re-quote after `stage` changes. MAX, amounts, `basis` still come from the chain block
of the quote.

```json
{
  "quote": {
    "instanceId": "…",
    "walletId": "…",
    "side": "buy",
    "stage": "priority",
    "requestedAmount": "1000000",
    "exceedsMax": true,
    "amountIn": "185185.18…",
    "maxIn": "185185.18…",
    "expectedOut": "5000000",
    "minOut": "4950000",
    "slippageBps": 100,
    "taxUsd1": "18518.51…",
    "taxBps": 1000,
    "refundUsd1": "0.000000000000000001",
    "priceBeforeUsd1": "0.00004166666625",
    "priceAfterUsd1": "0.0000435…",
    "max": {
      "amountIn": "185185.18…",
      "amountOut": "5000000",
      "limitedBy": "quota"
    },
    "quota": {
      "capMeme": "5000000",
      "usedMeme": "0",
      "remainingMeme": "5000000"
    },
    "inventory": {
      "saleSupply": "800000000",
      "soldSupply": "0",
      "remainingMeme": "800000000"
    },
    "eligibility": { "required": true, "eligible": true, "reasonCode": null },
    "deadline": "2027-01-23T07:06:00.000Z",
    "quotedAt": "2027-01-23T07:05:00.000Z",
    "basis": { "blockNumber": "1301", "blockHash": "0x…" }
  },
  "contractVersion": "2.0"
}
```

- **MAX** = `max.amountIn` (fill the input with it). `limitedBy`: `quota` (0.5 % = 5,000,000
  MEME per address, both rounds, selling does not restore it) | `inventory` (remaining of
  800M) | `balance` (wallet USD1 / MEME) | `sold_supply` (sell) | `closed` (parity with
  `CurveEngine.quoteMaxBuy` only: the route answers a closed stage with the 409 above before
  computing MAX, so the App does not see `closed` in a 200).
- `exceedsMax: true` → show "超出可买上限" with a one-tap fill of MAX; the quote numbers are
  for MAX.
- Pass `amount`, `minOut`, `deadline` unchanged to §3.5. Re-quote when `deadline` passes.
- `eligibility.required` in the priority hour: `eligible: false` → grey the panel
  ("提前购仅限名单内持有人"); `reasonCode: LAUNCH2_SNAPSHOT_UNVERIFIED` → show unavailable.

### 3.4 `POST /v2/launch2/instances/{instanceId}/nft/prepare`

Body `{"walletId": "…"}`. `201`:

```json
{
  "launch2Intent": {
    "intentId": "…",
    "kind": "nft_mint",
    "state": "prepared",
    "instanceId": "…",
    "walletId": "…",
    "chainId": "eip155:97",
    "chainReference": 97,
    "contractAddress": "0x<nft>",
    "amountIn": "100",
    "expectedOut": "0.000000000000000001",
    "minOut": "0.000000000000000001",
    "taxUsd1": "0",
    "refundUsd1": "0",
    "deadline": "…sale end…",
    "expiresAt": "…",
    "createdAt": "…",
    "calldata": { "to": "0x<nft>", "data": "0x1249c58b", "value": "0" },
    "unsignedTransaction": {
      "chainId": 97,
      "to": "0x<nft>",
      "data": "0x1249c58b",
      "value": "0x0",
      "from": "0x…",
      "gas": "0x…",
      "nonce": "0x8",
      "type": "legacy",
      "gasPrice": "0x…",
      "maxFeePerGas": null,
      "maxPriorityFeePerGas": null
    },
    "approval": {
      "token": "0x<usd1>",
      "spender": "0x<nft>",
      "amount": "100",
      "calldata": { "to": "0x<usd1>", "data": "0x095ea7b3…", "value": "0" },
      "unsignedTransaction": { "…": "nonce N" }
    },
    "payloadDigest": "…",
    "snapshotBlockNumber": "1200",
    "snapshotBlockHash": "0x…",
    "simulation": {
      "status": "unavailable",
      "reasonCode": "LAUNCH2_APPROVAL_REQUIRED"
    },
    "policy": {
      "configVersion": "bscWriteCanaryV1",
      "canaryMaxUsd": "…",
      "valueUsd": "100",
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

Signing: when `approval` is non-null send `approval.unsignedTransaction` first (nonce N), then
`unsignedTransaction` (N+1), both through the embedded wallet `eth_sendTransaction`. `signing.allowed`
false → do not sign (`LAUNCH2_INTENT_EXPIRED` → prepare again; `LAUNCH2_SIMULATION_REVERTED`).
The first-purchase sheet must show the full sentence 「不保证成交、不保证配售，公开内盘可能不发生」.

Counterparties (Decision 0117): the transaction `to`, `approval.token` and `approval.spender`
are always contracts of this activated instance (`contracts` in §3.2) or the instance's USD1;
the server refuses anything else with `403 POLICY_BLOCKED` / `LAUNCH2_COUNTERPARTY_NOT_INSTANCE`
(should never happen; show "暂不可用" and do not sign). USD1 must still be a canary asset
(`ASSET_NOT_IN_CANARY_ALLOWLIST`) and the canary per-intent / daily ceilings still apply.
The lane shows the mint in `viewer.nft` after indexing; there is no report route.

### 3.5 `POST /v2/launch2/instances/{instanceId}/trade/prepare`

Body `{"walletId", "side": "buy"|"sell", "amount", "minOut", "deadline"}` from §3.3. `201`: the
same resource with `kind: "buy"|"sell"`, `contractAddress` = curve,
`calldata` = `buy(amountInMax, minMemeOut, deadline, proof)` / `sell(memeIn, minUsd1Out, deadline)`,
`approval` for USD1 (buy) or MEME (sell) when short. The contract refunds unused USD1.

Deadline (Decision 0126): the body's `deadline` is the quote's (60 s): past it → `409
QUOTE_EXPIRED`. The deadline encoded in `buy` / `sell` and the intent's `deadline` / `expiresAt`
are `max(body.deadline, prepare time + 180 s)`, so the approve and the trade can both be signed.
Use `launch2Intent.expiresAt` as the signing limit; after it `state` is `expired` /
`signing.allowed = false` (`LAUNCH2_INTENT_EXPIRED`) → re-quote.

Refusals to handle in the panel (no toast, no error page):

- `409 QUOTE_EXPIRED / LAUNCH2_QUOTE_EXPIRED` → re-quote silently.
- `409 DATA_STALE / LAUNCH2_PRICE_MOVED` (`detailsSafe.expectedOut`) → 「价格已变化，已刷新」 and re-quote.
- `422 VALIDATION_FAILED / LAUNCH2_AMOUNT_ABOVE_MAX` (`maxAmountIn`, `limitedBy`) → offer MAX.
- `403 POLICY_BLOCKED / LAUNCH2_NOT_IN_SNAPSHOT` → priority hour, not a holder.
- An on-chain revert after signing (another order filled first, deadline passed) → re-quote.

### 3.6 `GET /v2/launch2/instances/{instanceId}/buybacks?limit=|cursor=`

```json
{
  "instanceId": "…",
  "summary": { "…": "as instance.buyback" },
  "live": {
    "paused": false,
    "lastSuccessfulAt": null,
    "escrowRecordedUsd1": "200",
    "escrowSpentUsd1": "0",
    "escrowAvailableUsd1": "200",
    "nextOrderUsd1": "100",
    "nextOrderBlockedReason": "BUYBACK_NOT_GRADUATED"
  },
  "liveUnavailable": null,
  "buybacks": [
    {
      "buybackId": "…",
      "outcome": "executed",
      "reasonCode": null,
      "usd1Spent": "100",
      "memeDelivered": "150000",
      "minMemeOut": null,
      "referencePriceUsd1": null,
      "spotPriceUsd1": null,
      "executedAt": "…",
      "transactionHash": "0x…",
      "blockNumber": "…"
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

`buybacks[].minMemeOut / referencePriceUsd1 / spotPriceUsd1` (Decision 0122): `decimal | null` —
`null` for every execution of a v3 (third Factory) instance, which has no price protection
(minOut 0); old-Factory executions keep all three. Do not render them when null.

`nextOrderBlockedReason` (Decision 0122, redefined from `quoteNextOrder().executable` of one
block): `null` = the next order can run now | `BUYBACK_PAUSED` (回购已暂停) |
`BUYBACK_NOT_GRADUATED` (未毕业) | `BUYBACK_NO_BUDGET` (托管余额为 0) | `BUYBACK_TOO_SOON` (距上一笔
成功 < 10 s) | `BUYBACK_PRINCIPAL_INSUFFICIENT` (官方池本金保护：USD1 本金 < 10,000 或单笔 > 1%) |
`BUYBACK_QUOTE_UNAVAILABLE` (合约报价读取失败) | `BUYBACK_LEGACY_PRICE_PROTECTION` (仅旧工厂实例：参考价
未就绪或价格保护会拒绝). `BUYBACK_PROTECTION_BLOCKED` and `BUYBACK_PRICE_SOURCE_UNAVAILABLE` are no
longer produced; treat any unknown value as 「回购暂缓」. Refused attempts are not listed in
`buybacks` (they revert without a log); the keeper's latest refusal is
`summary.keeper` (§3.2, Decision 0121). `live: null` + `liveUnavailable.reasonCode` when the
chain read fails. Copy: 「回购不等于销毁」 in ⓘ.

### 3.7 `GET /v2/launch2/me/positions`

```json
{
  "positions": [
    {
      "instanceId": "…",
      "name": "Frog Launch",
      "ticker": "FROG",
      "logoUrl": "…",
      "memeAddress": "0x…6666",
      "stage": "priority",
      "walletId": "…",
      "nft": { "mintedTokenId": "1", "held": 1 },
      "snapshotMember": true,
      "curve": {
        "bought": "1125000.5",
        "sold": "0",
        "net": "1125000.5",
        "cumulativeBought": "1125000.5",
        "remainingQuota": "3874999.5",
        "usd1Spent": "50",
        "usd1Received": "0",
        "taxUsd1": "5"
      },
      "lastActivityAt": "…",
      "memeBalance": null,
      "usd1Balance": null,
      "balanceStatus": "not_graduated",
      "balanceReasonCode": null,
      "balanceBlockNumber": null,
      "poolTradeCount": "0",
      "lastPoolTradeAt": null
    }
  ],
  "contractVersion": "2.0"
}
```

`curve.net` is curve bought − sold (curve phase only).

Decision 0126 — wallet balances and own pool trades (same seven keys on the detail `viewer`, §3.2):

| key                  | graduated (`stage = graduated`)                                             | before graduation |
| -------------------- | --------------------------------------------------------------------------- | ----------------- |
| `memeBalance`        | MEME `balanceOf(wallet)` at `balanceBlockNumber` (null when unavailable)    | `null`            |
| `usd1Balance`        | the instance USD1 `balanceOf(wallet)` at the same block                     | `null`            |
| `balanceStatus`      | `available` \| `unavailable` (chain read failed / launch slot not set up)   | `not_graduated`   |
| `balanceReasonCode`  | `unavailable`: `LAUNCH2_CHAIN_READ_FAILED` / `LAUNCH2_CHAIN_NOT_CONFIGURED` | `null`            |
| `balanceBlockNumber` | block of both reads                                                         | `null`            |
| `poolTradeCount`     | the wallet's attributed official-pool trades (`"0"` none)                   | `"0"`             |
| `lastPoolTradeAt`    | block time of its newest one                                                | `null`            |

- Balances are read live (one block, cached ≤ 15 s per wallet and instance); a failed read
  never becomes `"0"` — show 「余额暂不可用」 and keep the rest of the row.
- Graduated: show 「持有 {memeBalance} {ticker}」 from `memeBalance` (it covers curve buys, pool
  trades and wallet-to-wallet transfers); before graduation keep using `curve.net`.
- A wallet whose only activity is pool trades (through the router) is listed (curve zeros, no
  NFT). A wallet that only received MEME by transfer is not listed (open the detail with its
  `walletId` to see its balance).

### 3.8 `GET /v2/launch2/instances/{instanceId}/pool/quote?side=&mode=&amount=&walletId=&slippageBps=` (Decision 0124)

Graduated instances only. `side` `buy` (USD1 → MEME) | `sell` (MEME → USD1); `mode` `exactIn`
(`amount` = what the wallet pays: buy USD1, sell MEME) | `exactOut` (`amount` = what the wallet
receives **after** the 2 % tax: buy MEME, sell USD1); `amount` decimal string (> 0, ≤ 18
decimals); `walletId` required (the signing wallet; its balances are shown); `slippageBps`
0..5000, default 100.

The server simulates the router (`eth_call`, the wallet's input-token balance / allowance
overridden in the call only) on the official pool at one block. No fixture is ever returned.

```json
{
  "quote": {
    "instanceId": "8a0c…",
    "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
    "venue": "official_pool",
    "side": "buy",
    "mode": "exactIn",
    "stage": "graduated",
    "requestedAmount": "10",
    "amountIn": "10",
    "maxIn": "10",
    "expectedOut": "15680",
    "minOut": "15523.2",
    "slippageBps": 100,
    "taxBps": 200,
    "taxAmount": "320",
    "taxToken": "meme",
    "taxUsd1": "0",
    "priceBeforeUsd1": "0.000625",
    "averagePriceUsd1": "0.000637755102040816",
    "balance": { "usd1": "1000", "meme": "2000000" },
    "exceedsBalance": false,
    "router": "0xcb022501a427154501adce5b6dc8f16674ae8f5d",
    "poolId": "0x67ff…882d",
    "poolKey": {
      "currency0": "0x3a1236e68ecf3225640367c84b6f50a51d0b0195",
      "currency1": "0x…6666",
      "fee": 2500,
      "tickSpacing": 60,
      "hooks": "0x…20cc"
    },
    "zeroForOne": true,
    "deadline": "2027-01-15T08:01:00.000Z",
    "expiresAt": "2027-01-15T08:01:00.000Z",
    "quotedAt": "2027-01-15T08:00:00.000Z",
    "quotedAtBlock": "135999001",
    "basis": { "blockNumber": "135999001", "blockHash": "0x…" }
  },
  "contractVersion": "2.0"
}
```

Field meaning by mode:

| field         | exactIn                               | exactOut                                                        |
| ------------- | ------------------------------------- | --------------------------------------------------------------- |
| `amountIn`    | = amount                              | simulated input for the requested net output                    |
| `maxIn`       | = amountIn                            | amountIn × (1 + slippage), rounded up (router refunds the rest) |
| `expectedOut` | simulated net output (after 2 % tax)  | = amount                                                        |
| `minOut`      | expectedOut × (1 − slippage), down    | = amount                                                        |
| `taxAmount`   | 2 % of the gross output (≤ 1 wei off) | exact hook tax                                                  |

- Show 「外盘交易税 2 %（{taxAmount} {taxToken}）」; `taxUsd1` is only non-zero on a sell.
- `exceedsBalance: true` → disable the confirm button, offer the balance as MAX (`balance`).
- Re-quote when `expiresAt` passes (TTL 60 s); the prepare re-quotes itself anyway.
- Decision 0126: the quote's `deadline` / `expiresAt` are only its freshness. The prepare
  (§3.9) re-simulates at its own block and encodes its own deadline (prepare + 180 s); the
  `quote` returned with the intent carries that deadline (`deadline = expiresAt` = the
  intent's).

### 3.9 `POST /v2/launch2/instances/{instanceId}/pool/trade/prepare` (Decision 0124)

Headers: §1 plus `Idempotency-Key`. Body:

```json
{
  "walletId": "d64786bb-…",
  "side": "buy",
  "mode": "exactIn",
  "amount": "10",
  "slippageBps": 100
}
```

`slippageBps` is an integer here (required). `201`:

```json
{
  "launch2Intent": {
    "intentId": "…",
    "kind": "pool_buy",
    "state": "prepared",
    "contractAddress": "0xcb022501a427154501adce5b6dc8f16674ae8f5d",
    "amountIn": "10",
    "expectedOut": "15680",
    "minOut": "15523.2",
    "taxUsd1": "0",
    "refundUsd1": "0",
    "deadline": "2027-01-15T08:03:00.000Z",
    "expiresAt": "2027-01-15T08:03:00.000Z",
    "calldata": { "to": "0xcb02…", "data": "0x2523c148…", "value": "0" },
    "unsignedTransaction": {
      "chainId": 97,
      "to": "0xcb02…",
      "data": "0x2523c148…",
      "value": "0x0",
      "from": "0x…",
      "gas": "0x34bc0",
      "nonce": "0x8",
      "type": "legacy",
      "gasPrice": "0x3b9aca00",
      "maxFeePerGas": null,
      "maxPriorityFeePerGas": null
    },
    "approval": {
      "token": "0x3a12…0195",
      "spender": "0xcb02…",
      "amount": "10",
      "calldata": { "to": "0x3a12…0195", "data": "0x095ea7b3…", "value": "0" },
      "unsignedTransaction": { "…": "nonce 0x7" }
    },
    "simulation": { "status": "passed", "reasonCode": null },
    "signing": {
      "mode": "device_eth_send_transaction",
      "allowed": true,
      "reasonCode": null
    },
    "…": "payloadDigest, snapshotBlockNumber/Hash, policy as §3.4"
  },
  "quote": { "…": "the §3.8 quote the intent was built from" },
  "contractVersion": "2.0"
}
```

- `calldata` = `swapExactIn(key, zeroForOne, amountIn, minOut, wallet, deadline)` (selector
  `0x2523c148`) or `swapExactOut(key, zeroForOne, amountOut, maxIn, wallet, deadline)`
  (`0x2dfe07a9`); recipient is always the signing wallet.
- `approval` (non-null) must be signed and mined first (nonce N), then the router call (N+1).
  Buy approves USD1, sell approves MEME, amount = `amountIn` (exactIn) / `maxIn` (exactOut).
- `simulation.status`: `passed` (with a pending approve: passes once the approve lands);
  `reverted` → `signing.allowed = false` (`LAUNCH2_SIMULATION_REVERTED`), re-quote;
  `unavailable` → the node could not estimate; signing still allowed with the fallback gas.
- `amountIn` on the intent is the most the router may pull; the router refunds the unused part
  of `maxIn`.
- Replays with the same key return the same intent **and** the same `quote`.
- Decision 0126: `deadline` = `expiresAt` = prepare time + 180 s (server
  `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS`, 60..600, default 180); the router call encodes the same
  deadline; `quote.basis` / `quotedAtBlock` = the prepare block (a fresh simulation, not the
  earlier GET). Sign the approve and then the router call before `expiresAt`; after it the
  intent is `expired` → prepare again (new `Idempotency-Key`).
- Confirmation (0126): after the router transaction is mined, poll the detail (or §3.11) until
  `viewer.poolTradeCount` grows (the lane needs the block plus confirmations); do not use the
  pool-wide `pool.tradeCount` (buybacks and other wallets move it too).

### 3.10 `instance.pool` on `GET /v2/launch2/instances/{instanceId}` (Decision 0124)

`null` before graduation; after:

```json
"pool": {
  "poolId": "0x67ff…882d",
  "router": "0xcb022501a427154501adce5b6dc8f16674ae8f5d",
  "tradeCount": "3",
  "buyCount": "2",
  "sellCount": "1",
  "buyVolumeUsd1": "150",
  "sellVolumeUsd1": "40",
  "volume24hUsd1": "190",
  "taxUsd1": "0.8",
  "taxMeme": "4800",
  "lastPriceUsd1": "0.000625",
  "lastTradeAt": "2027-01-15T07:59:30.000Z",
  "userTradeCount": "2",
  "userBuyVolumeUsd1": "50",
  "userSellVolumeUsd1": "40"
}
```

- Decision 0127 (required keys): `userTradeCount` (uint string), `userBuyVolumeUsd1`,
  `userSellVolumeUsd1` (decimal strings) = the same totals **without** the swaps whose PoolManager
  caller is this instance's buyback adapter / executor (the keeper's buybacks). In the example one
  of the two buys (100 USD1) was a buyback. Show 「外盘成交」 / market volume from `user*`; the buyback
  card keeps using `buyback.*` (the buyback ledger). Before graduation `pool` is still `null`; after
  graduation with no swap all three are `"0"`. Not configurable, never estimated: they come from the
  same indexed facts as `tradeCount` (a rewound swap leaves both).
- Counts every swap of the official pool (the App router, the buyback executor, any other
  router). Volumes are the USD1 side (sell volume = USD1 out before tax). `lastPriceUsd1` is
  the pool price after the latest indexed swap (`null` until the first one — then use the quote's
  `priceBeforeUsd1`). `router: null` = pool trading not configured on this server: hide the
  pool trade panel, keep the statistics.
- `recentTrades` stays curve-only.

### 3.11 `GET /v2/launch2/instances/{instanceId}/pool/trades?walletId=&limit=` (Decision 0126)

The caller's wallet's own official-pool trades, newest first. `walletId` required (one of the
caller's wallets: else `404`); `limit` 1..50, default 20 (no cursor). Headers as §1 (read).

The `launch2_event` lane reads `OfficialPoolRouter`'s own `Swap(poolId, payer, recipient,
zeroForOne, amountIn, amountOut)` logs beside the PoolManager `Swap` and pairs them (same
transaction, PoolManager sender = the router, router log after it, same input amount); the payer
is the trader. Swaps that did not go through the router (the buyback executor, other routers)
are never attributed to anyone.

```json
{
  "instanceId": "8a0c…",
  "walletId": "d64786bb-408d-415d-8a69-6277d56c921b",
  "poolTradeCount": "2",
  "lastPoolTradeAt": "2027-01-15T08:00:40.000Z",
  "trades": [
    {
      "poolTradeId": "5e0f0a8e-4c0a-4b8e-9a0c-2f7d1c3b4a50",
      "side": "buy",
      "inputToken": "usd1",
      "outputToken": "meme",
      "amountIn": "10",
      "amountOut": "15680",
      "usd1Amount": "10",
      "memeAmount": "16000",
      "taxAmount": "320",
      "taxToken": "meme",
      "priceUsd1": "0.000625",
      "recipientAddress": "0x…000a",
      "tradedAt": "2027-01-15T08:00:40.000Z",
      "transactionHash": "0xabab…",
      "logIndex": 4,
      "blockNumber": "136098447"
    }
  ],
  "contractVersion": "2.0"
}
```

- `amountIn` / `amountOut` = what the wallet paid / received net (router event, exact);
  `usd1Amount` / `memeAmount` = the pool side (output before the 2 % tax); `priceUsd1` = pool
  price after the swap. Show 「买入 {amountOut} {ticker}，花费 {amountIn} USD1」 / 「卖出 …」.
- `poolTradeId` is opaque and stable (use it as the list key; never the hash).
- Before graduation: `200` with `trades: []`, `poolTradeCount: "0"`.
- Errors: `400 INVALID_REQUEST` (no / bad `walletId`, bad `limit`), `404 NOT_FOUND` (unknown
  instance `LAUNCH2_INSTANCE_NOT_FOUND`, or a wallet that is not the caller's), `503` as §5.
- Unattributed history: pool trades the lane indexed before it read router logs are attributed
  by its one-time re-scan from the graduation block once the worker runs with
  `LAUNCH2_POOL_ROUTER_*`; until then they are missing here (never guessed).

## 4. Errors (seven-field envelope; `detailsSafe.reasonCode` names the rule)

| HTTP | code                             | reasonCode                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | — (bad query / body / cursor)                                                                                                                                                                                                                                                                                                                                                                                          |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 403  | `POLICY_BLOCKED`                 | `LAUNCH2_NOT_IN_SNAPSHOT`; `LAUNCH2_COUNTERPARTY_NOT_INSTANCE` (Decision 0117); canary: `ASSET_NOT_IN_CANARY_ALLOWLIST`, `CANARY_CEILING_EXCEEDED`, `CANARY_DAILY_CEILING_EXCEEDED` (as Decision 0065). The static `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST` no longer applies to launch2                                                                                                                                 |
| 404  | `NOT_FOUND`                      | `LAUNCH2_INSTANCE_NOT_FOUND`; a foreign walletId has no reason                                                                                                                                                                                                                                                                                                                                                         |
| 409  | `DATA_STALE`                     | `LAUNCH2_STAGE_MISMATCH` (`stage` = read-model stage; also when the chain is ahead of the lane, S143), `LAUNCH2_SELL_NOT_OPEN`, `LAUNCH2_SOLD_OUT`, `LAUNCH2_QUOTA_EXHAUSTED`, `LAUNCH2_INSTANCE_PAUSED` (`holdReason`), `LAUNCH2_NFT_ALREADY_MINTED`, `LAUNCH2_PRICE_MOVED`                                                                                                                                           |
| 409  | `QUOTE_EXPIRED`                  | `LAUNCH2_QUOTE_EXPIRED`                                                                                                                                                                                                                                                                                                                                                                                                |
| 409  | `INSUFFICIENT_BALANCE`           | `LAUNCH2_USD1_BALANCE_INSUFFICIENT`, `LAUNCH2_MEME_BALANCE_INSUFFICIENT`, `LAUNCH2_GAS_INSUFFICIENT`                                                                                                                                                                                                                                                                                                                   |
| 409  | `IDEMPOTENCY_CONFLICT`           | —                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 422  | `VALIDATION_FAILED`              | `LAUNCH2_AMOUNT_INVALID`, `LAUNCH2_AMOUNT_ABOVE_MAX`, `LAUNCH2_DEADLINE_TOO_FAR`, `LAUNCH2_QUOTE_ZERO`, `LAUNCH2_WALLET_NOT_EMBEDDED`; pool (0124): `POOL_NOT_GRADUATED` (`stage`), `POOL_QUOTE_UNAVAILABLE` (`revertReason`: contract error name, `UNKNOWN`, or `STATE_OVERRIDE_UNSUPPORTED`), `POOL_INSUFFICIENT_LIQUIDITY`, `POOL_QUOTE_ZERO`                                                                       |
| 503  | `CAPABILITY_UNAVAILABLE`         | `LAUNCH2_FACTORY_NOT_CONFIGURED`, `LAUNCH2_CHAIN_NOT_CONFIGURED`, `LAUNCH2_REPOSITORY_UNAVAILABLE`, `LAUNCH2_RUNTIME_UNAVAILABLE`, `LAUNCH2_CHAIN_READ_FAILED`, `LAUNCH2_WALLETS_UNAVAILABLE`, `LAUNCH2_WRITES_DISABLED`, `LAUNCH2_MAINNET_SIGNING_CLOSED`, `LAUNCH2_SNAPSHOT_UNVERIFIED`; pool (0124): `POOL_ROUTER_NOT_CONFIGURED`, `POOL_ROUTER_CODE_MISMATCH`, `POOL_ROUTER_MANAGER_MISMATCH`, `POOL_KEY_MISMATCH` |

### 4.1 `INSUFFICIENT_BALANCE` numbers (S157, Decision 0129 §1)

Every `409 INSUFFICIENT_BALANCE` carries the numbers behind the refusal next to `reasonCode`.
All values are decimal strings in whole units (18 decimals, e.g. `"99.5"`), read at the same
block as the check. Keys that existed before S157 are unchanged; the `balance*` / `requiredBnb`
keys are additive.

- `POST …/nft/prepare`, `LAUNCH2_USD1_BALANCE_INSUFFICIENT`: `requiredUsd1` (the NFT price),
  `balanceUsd1` (the wallet's USD1).
- `POST …/trade/prepare` (curve), balance-bound: `maxAmountIn` (the executable max) plus
  `balanceUsd1` (buy, `LAUNCH2_USD1_BALANCE_INSUFFICIENT`) or `balanceMeme` (sell,
  `LAUNCH2_MEME_BALANCE_INSUFFICIENT`).
- `POST …/pool/prepare` (official pool): `maxAmountIn` (= the input-token balance),
  `requiredAmountIn` (the trade's maxIn) plus `balanceUsd1` (buy) or `balanceMeme` (sell).
- `LAUNCH2_GAS_INSUFFICIENT` (every launch2 prepare): `requiredBnb` = the gas fee ceiling
  (gas limit of the call, plus the approve when one is needed, × maxFeePerGas or gasPrice),
  `balanceBnb` = the wallet's BNB.

Example:

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "category": "conflict",
  "retryable": false,
  "userMessageKey": "errors.balance.insufficient",
  "correlationId": "…",
  "detailsSafe": {
    "reasonCode": "LAUNCH2_GAS_INSUFFICIENT",
    "requiredBnb": "0.000412",
    "balanceBnb": "0.0001"
  },
  "providerReferenceSafe": null
}
```

## 5. Unavailable behaviour

Never fabricate a stage, price, or list: a 503 shows the module unavailable with retry; an
empty `instances` list is the empty state (the lane has indexed nothing yet). `viewer: null`
means no wallet, not zero holdings. `buyback.keeper: null` means the keeper has not run for
this instance (lane off by default, or not graduated): show the ledger only, no "回购暂缓".

Wallet balances (0126): `balanceStatus: "unavailable"` never blocks the detail / positions; show
「余额暂不可用」 for that row only. Without the router in the worker, pool trades stay unattributed
(`poolTradeCount: "0"`, §3.11 empty) — the pool statistics still move.

Pool trading (0124): `POOL_ROUTER_NOT_CONFIGURED` / `POOL_ROUTER_CODE_MISMATCH` /
`POOL_ROUTER_MANAGER_MISMATCH` / `POOL_KEY_MISMATCH` are server-side states — show 「外盘交易暂不可用」
with retry, never a price. `POOL_NOT_GRADUATED` means the read model has not confirmed the
graduation yet (or the instance is not graduated): show the curve panel. `POOL_QUOTE_UNAVAILABLE`
/ `POOL_INSUFFICIENT_LIQUIDITY` / `POOL_QUOTE_ZERO` belong in the panel next to the amount
(「金额过大，池子深度不足」/「金额过小」/「暂时无法报价」).

## 6. Preflight samples to add (coordinator)

Proposed new files under `docs/integration/preflight-2026-09-16/responses/` (not created by
this batch): `launch2-capabilities.json` (capability row), `launch2-instances-list.json`,
`launch2-instances-empty.json`, `launch2-instance-detail-nft-sale.json`,
`launch2-instance-detail-priority.json`, `launch2-instance-detail-graduated.json`,
`launch2-quote-buy-max-quota.json`, `launch2-quote-buy-exceeds-max.json`,
`launch2-nft-prepare.json`, `launch2-trade-prepare-buy.json`,
`launch2-error-quote-expired.json`, `launch2-error-price-moved.json`,
`launch2-error-not-in-snapshot.json`, `launch2-error-unavailable.json`,
`launch2-buybacks.json`, `launch2-me-positions.json`.
