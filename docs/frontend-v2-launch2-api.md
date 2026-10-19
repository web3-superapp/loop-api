# Frontend contract: MEME v2 (`launch2`) — Decision 0114 (+ 0117, 0118, 0121, 0122, 0124, 0126, 0127, 0131, 0139)

> **S181 / 决策 0139 变化（给 App）**：新增只读路由 `GET /v2/launch2/overview`（§3.13）= 发射台「实时流」
> （跨实例最新 30 条：内盘 / 外盘买卖、NFT 铸造、毕业、回购、奖励轮次开启、奖励领取）+「战绩」计数。
> 纯新增，现有路由与键集合不变。随列表 60 s 轮询一起拉，不单独加定时器；`activity` 为空时整行不渲染。

> **S166 / 决策 0131 变化（给 App）**：新增可选外盘 Hook 种类 **`loopDynamic`**（需求方 loop_hook_v1，
> 买卖各 2 % + 动态卖出税 + 奖励轮次），**服务端默认关闭**，现有实例全是 `officialTax`，行为不变。
> ① 新路由 `GET …/dynamic-pool`（§3.12）对**任何**实例都回答 `hookKind`：`officialTax` → 走原外盘面板；
> `loopDynamic` → 新面板。**不要**从详情里找 `hookKind`（详情 / `pool` 键集合不变，旧包严格解码不受影响）。
> ② `loopDynamic` 实例的 `…/pool/quote` / `…/pool/trade/prepare` 只支持 `mode=exactIn`（隐藏「按买入数量」），
> 报价多一个 `quote.dynamic` 对象；授权对象与 `to` 是 `LoopRouter`。③ 新增奖励列表与领取
> （`…/dynamic-pool/rewards`、`…/dynamic-pool/claim/prepare`、`…/dynamic-pool/claim/report`），新意图种类
> `dynamic_claim`。④ `quote.taxBps` 的 schema 从常量 200 放宽为 0..10000（值仍是 200）。

> **S151 / 决策 0127 变化（给 App）**：`instance.pool` 新增三个**必带**键 `userTradeCount` /
> `userBuyVolumeUsd1` / `userSellVolumeUsd1`（§3.10）：与 `tradeCount` / `buyVolumeUsd1` / `sellVolumeUsd1`
> 同口径，但**剔除本实例回购适配器 / 执行器发起的池内成交**（即外盘市场成交）。原字段含义不变（仍含回购）。
> 「外盘成交 N 笔 / 外盘买入 / 卖出量」请改用 `user*`；`tradeCount - userTradeCount` = 已索引的回购成交笔数。
> **部署顺序**：严格解码器会拒绝未知键的旧包，须先发能接受这三个键的包，再上这一版 API。

> **S239 / 决策 0162 变化（给 App）**：`instance.recentTrades[]`（§3.2）、`…/pool/trades` 的 `trades[]`
> （§3.11）与 `GET /v2/launch2/overview` 的 `activity[]`（§3.13）每条新增 `account`，形状与 MEME 成交**完全相同**：
> `{ "publicProfileId": "…", "displayName": "alias 或 null", "avatarRef": "avatar:… 或 null" }` 或 `null`。
> 有值 → 显示头像 / 名字，点按打开 `GET /v2/public-profiles/{publicProfileId}`；`null` → 继续显示缩短的钱包地址
> （没有绑定账户、资料未激活、或对方把「交易记录」设为仅自己可见；本人永远看得到自己）。服务端最长缓存 30 s。
> 新增键在 schema 里是可选的；严格解码的客户端须先接受 `account` 再上这一版 API。
>
> **S248 / 决策 0166（热修）**：上面的 `account` **默认不下发**（键整个不存在），由服务端
> `LAUNCH2_TRADER_ACCOUNT_EMIT`（`off` 默认 / `on`）控制。build ≤ 30 的严格解码器遇到该键会让整页报
> 「返回的数据不完整」。App 须在 codec 里把三处的 `account` 加为**可选键**（缺省 = 显示钱包地址）并随
> build ≥ 31 发版；全部受支持版本都 ≥ 31 后，服务端才把开关切到 `on`。

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
        "account": {
          "publicProfileId": "3f0c…",
          "displayName": "frog",
          "avatarRef": "avatar:media/…"
        },
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

- Show 「外盘交易税 2 %（{taxAmount} {taxToken}）」; `taxUsd1` is non-zero on a sell and, for a
  LoopDynamic S209 Hook (`taxToken = "usd1"` on a buy, Decision 0152), on a buy as well.
- Decision 0165: the `pool/trade/prepare` intent's `taxUsd1` equals the quote's `taxUsd1`
  (same figure, same precision) for every side: a USD1-taxed buy carries the USD1 fee (e.g.
  10 USD1 at 2 % → `"0.2"`), a MEME-taxed buy `"0"`, a sell the base + dynamic USD1 fee.
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
      "account": {
        "publicProfileId": "3f0c…",
        "displayName": "me",
        "avatarRef": null
      },
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

### 3.12 外盘 Hook 种类 = `loopDynamic`（Decision 0131，S166）

**What it is.** A `loopDynamic` instance graduates into a Uniswap v4 pool whose per-project Hook
(`LoopDynamicHook`, bound in the graduation transaction) charges **2 % on buys (in MEME, from the
output) and 2 % on sells (in USD1)**, plus a **dynamic sell fee** while a reward round is armed: a
5-minute candle that closes more than 10 % down arms a round; while armed, sells pay the current
candle's drop (`POST_SWAP`: the drop after the sell) on top of the 2 %, that extra goes to the
round's pot; buys during the round earn **reward weight = USD1 spent**; the first green candle
closes the round and half the pot (carry + dynamic fees) is split by weight, the other half carries
over. Buybacks earn no weight and pay no buy fee. Trades go through **LoopRouter**, exact input
only. Base URL, headers, auth, the seven-field error envelope and `X-Loop-Contract-Version: 2.0`
as §1; every route needs the session.

**How the App decides.** Call `GET …/dynamic-pool` for the instance (any stage). `hookKind`
`officialTax` + `status: not_applicable` → keep the existing panel (§3.8–§3.11) and ignore the
rest. `loopDynamic` + `not_graduated` → curve panel as before; after graduation `active` → the
LoopDynamic panel below. 503 on this route (any reason) for a `loopDynamic` instance → show
「外盘暂不可用」 with retry; never fall back to the OfficialTax panel or the old router.

#### 3.12.1 `GET /v2/launch2/instances/{instanceId}/dynamic-pool?walletId=`

`walletId` optional (default: the active wallet; `viewer: null` without one).

```json
{
  "dynamicPool": {
    "instanceId": "4f3c…",
    "hookKind": "loopDynamic",
    "status": "active",
    "hook": "0xcccc…10c4",
    "poolId": "0x…",
    "router": "0x7777…7777",
    "routerRegistry": "0x4444…4444",
    "routingPolicy": "open",
    "priceTiming": "POST_SWAP",
    "buyTaxBps": 200,
    "baseSellTaxBps": 200,
    "excludeBuybackFromRewards": true,
    "armed": true,
    "currentRoundId": "3",
    "candleId": "6000000",
    "candleSeconds": 300,
    "candleEndsAt": "2027-01-15T08:05:00.000Z",
    "rollPending": false,
    "currentDropWad": "0.3",
    "currentDropBps": 3000,
    "potUsd1": "45",
    "carryUsd1": "40",
    "roundExtraFeesUsd1": "5",
    "roundTotalBuyWeightUsd1": "100",
    "reservedRewardsUsd1": "10",
    "priceUsd1": "0.000625",
    "viewer": { "walletId": "d647…", "currentRoundWeightUsd1": "25" },
    "summary": {
      "roundCount": 3,
      "closedRoundCount": 2,
      "allocatedUsd1": "30",
      "claimedUsd1": "12",
      "dynamicFeesUsd1": "70",
      "baseSellFeesUsd1": "4",
      "buyFeesMeme": "1000"
    },
    "basis": { "blockNumber": "6000", "blockHash": "0x…" }
  },
  "contractVersion": "2.0"
}
```

- `not_applicable` / `not_graduated`: every field except `instanceId`, `hookKind`, `status`,
  `candleSeconds` is `null`.
- Decision 0132: every dependency `503` of this route (`LAUNCH2_CHAIN_READ_FAILED`,
  `LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED`, `_ROUTER_CODE_MISMATCH`, `_HOOK_NOT_INDEXED`,
  `_HOOK_MISMATCH`, `_HOOK_NOT_INITIALIZED`, repository unavailable) carries
  `detailsSafe.hookKind` (`officialTax` / `loopDynamic`, the registry row — a database fact). When
  the first read fails, use it to pick the panel: `loopDynamic` → the LoopDynamic panel in its
  unavailable state (exactIn only; never the OfficialTax panel). Only a `404` or a `503` before the
  instance is read lacks the key. Example:
  `{"code":"CAPABILITY_UNAVAILABLE",…,"detailsSafe":{"reasonCode":"LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED","hookKind":"loopDynamic"},…}`.
- 本轮状态卡: `armed`（激活中 / 未激活）、`currentDropBps`（当前跌幅，`30.00 %`）、`potUsd1`（奖金池）、
  `viewer.currentRoundWeightUsd1`（我的本轮权重，占比 = 它 / `roundTotalBuyWeightUsd1`）、`candleEndsAt`
  （本根 K 线结束时间；出现一根收绿的 K 线本轮结束）。`rollPending: true` = the candle already ended
  and the next trade / `poke` closes it (the keeper pokes armed Hooks on time when enabled).
- `currentDropWad` is `0` while not armed or while a roll is pending (the Hook's own view).
- Amounts are decimal strings (18 decimals); ids are strings; never parse to `double`.

#### 3.12.2 Trading a `loopDynamic` pool (`…/pool/quote`, `…/pool/trade/prepare`)

Same routes, query and body as §3.8 / §3.9, with these differences:

- **`mode=exactIn` only.** `exactOut` → `422 VALIDATION_FAILED / LAUNCH2_EXACT_OUT_UNSUPPORTED`
  before any chain read. Hide 「按买入数量」.
- `router` (and the prepare's `contractAddress`, `calldata.to`, `approval.spender`) is
  **LoopRouter**; the call is `swapExactInput(key, zeroForOne, amountIn, minOut, limit, deadline)`;
  `poolKey.hooks` is the LoopDynamic Hook. Kinds stay `pool_buy` / `pool_sell`.
- `taxBps` = the base rate (buy 200 in MEME, sell 200 in USD1); `taxAmount` = everything the Hook
  takes (sell: base + dynamic). The quote adds:

```json
"dynamic": {
  "hookKind": "loopDynamic",
  "hook": "0xcccc…10c4",
  "priceTiming": "POST_SWAP",
  "baseTaxBps": 200,
  "baseTaxAmount": "2",
  "dynamicTaxBps": 3000,
  "dynamicTaxAmount": "29.4",
  "armed": true,
  "roundId": "3",
  "rewardWeight": "0"
}
```

卖出面板展示「基础税 2 % + 当前动态税 {dynamicTaxBps/100} %」（`dynamicTaxAmount` 是本笔将被收的动态税 USD1，
按成交后跌幅精确模拟）；买入面板展示「本笔计入奖励权重 {rewardWeight} USD1」（未激活时为 0：「当前未激活，
不计奖励」）。`dynamic` is absent on OfficialTax quotes.

- Additional errors on this branch: 422 `LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED` (池子拒绝了这个交易入口),
  `LAUNCH2_DYNAMIC_SWAP_UNSUPPORTED`; 409 `DATA_STALE / LAUNCH2_DYNAMIC_HOOK_BUSY` (池子正忙，请稍后重试);
  503 `LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED`, `LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH`,
  `LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED`, `LAUNCH2_DYNAMIC_HOOK_MISMATCH`,
  `LAUNCH2_DYNAMIC_HOOK_NOT_INITIALIZED`. All §3.8 / §3.9 codes still apply.
- `…/pool/trades` for `loopDynamic` instances (Decision 0132, 口径): LoopRouter emits no event, so a
  pool swap is the wallet's when the swap transaction's `from` is that wallet **and** the
  transaction called LoopRouter directly (`to` = LoopRouter, one swap in it) — which is exactly how
  the App's `…/pool/trade/prepare` calldata is sent. `amountIn` = the input, `amountOut` = what the
  wallet received (after the Hook fee), `taxAmount` = the Hook fee. Swaps through any other router
  or contract (including the platform buyback) are anonymous: counted in the detail's `pool`
  statistics, listed under no wallet. Same response shape and `poolTradeCount` as §3.11. The
  detail's `pool` statistics (counts, volumes, `taxUsd1` = real base + dynamic sell fees, `taxMeme`
  = buy fees) are correct.

#### 3.12.3 `GET /v2/launch2/instances/{instanceId}/dynamic-pool/rewards?walletId=&limit=`

`walletId` required (`400` without, `404` when not the caller's); `limit` ≤ 100 (default 50).

```json
{
  "instanceId": "4f3c…",
  "walletId": "d647…",
  "hookKind": "loopDynamic",
  "claimableUsd1": "10",
  "claimedUsd1": "5",
  "rounds": [
    {
      "roundId": "2",
      "status": "claimable",
      "weightUsd1": "100",
      "totalBuyWeightUsd1": "300",
      "allocationUsd1": "30",
      "claimableUsd1": "10",
      "claimedUsd1": null,
      "claimTransactionHash": null,
      "claimedAt": null,
      "startCandle": "100",
      "endCandle": "104",
      "activatedAt": "…",
      "closedAt": "…"
    }
  ],
  "contractVersion": "2.0"
}
```

`status`: `open`（本轮进行中，结束后可领）/ `claimable`（可领取）/ `claimed`（已领取，带交易哈希）/
`no_reward`（本轮无可领金额）. Only rounds in which the wallet has weight are listed, newest first.
An OfficialTax instance answers `hookKind: "officialTax"` with `rounds: []`.

#### 3.12.4 `POST /v2/launch2/instances/{instanceId}/dynamic-pool/claim/prepare`

Headers: command headers (§1, `Idempotency-Key` UUIDv4). Body `{ "walletId": "…", "roundId": "2" }`.
`201`:

```json
{
  "launch2Intent": {
    "intentId": "…",
    "kind": "dynamic_claim",
    "contractAddress": "0xcccc…10c4",
    "calldata": { "to": "0xcccc…10c4", "data": "0x379607f5…", "value": "0" },
    "approval": null,
    "expectedOut": "12",
    "signing": {
      "mode": "device_eth_send_transaction",
      "allowed": true,
      "reasonCode": null
    },
    "…": "same shape as every launch2 intent (§3.4)"
  },
  "claim": { "roundId": "2", "hook": "0xcccc…10c4", "claimableUsd1": "12" },
  "contractVersion": "2.0"
}
```

The server simulates `claim(roundId)` from the wallet first (`claim` closes an ended candle before
paying, so a round that is closing becomes claimable in the same transaction). Decision 0132:
`launch2Intent.expectedOut` always equals `claim.claimableUsd1` (both are that simulation's amount,
same formatting; an idempotent replay returns the stored intent). The amount actually paid is the
indexed `RewardClaimed` (`…/claim/report` → `confirmed`, `amountUsd1`). Errors:
422 `LAUNCH2_DYNAMIC_POOL_NOT_APPLICABLE` (OfficialTax), `POOL_NOT_GRADUATED`,
`LAUNCH2_DYNAMIC_ROUND_INVALID` (roundId beyond the current round), `LAUNCH2_WALLET_NOT_EMBEDDED`;
409 `DATA_STALE / LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED` (本轮还没有结束), `DATA_STALE / LAUNCH2_DYNAMIC_HOOK_BUSY`;
409 `RESOURCE_CONFLICT / LAUNCH2_DYNAMIC_ALREADY_CLAIMED` (本轮奖励已经领取过);
409 `INSUFFICIENT_BALANCE / LAUNCH2_DYNAMIC_NOTHING_TO_CLAIM` (本轮没有可领取的奖励) or
`LAUNCH2_GAS_INSUFFICIENT` (§4.1); 403 `POLICY_BLOCKED` (canary); 503 `LAUNCH2_WRITES_DISABLED`,
`LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED`, `LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED`,
`LAUNCH2_DYNAMIC_HOOK_MISMATCH`. Same `Idempotency-Key` + body replays the same intent.

#### 3.12.5 `POST /v2/launch2/instances/{instanceId}/dynamic-pool/claim/report`

After the device sends the claim: body `{ "intentId": "…", "transactionHash": "0x…" }` (command
headers; optional `walletId` / `roundId` echoes must match the intent, else 404). `200`:

```json
{
  "dynamicClaimReport": {
    "intentId": "…",
    "instanceId": "…",
    "walletId": "…",
    "roundId": "2",
    "transactionHash": "0x…",
    "status": "confirmed",
    "amountUsd1": "12",
    "claimedAt": "…",
    "blockNumber": "6010",
    "reportedAt": "…"
  },
  "contractVersion": "2.0"
}
```

`status: submitted` until the indexer has the transaction's `RewardClaimed` for that round and
wallet (then `confirmed` with the amount); report again (same hash is idempotent) or re-read
`…/rewards`. A different hash for the same intent → 409 `RESOURCE_CONFLICT /
LAUNCH2_DYNAMIC_CLAIM_TRANSACTION_CONFLICT`; an unknown / foreign intent → 404
`LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND`. A success toast is not chain confirmation; show
「领取已提交」 until `confirmed`.

#### 3.12.6 Unavailable behaviour and copy

Every LoopDynamic reason code has zh-CN copy in `launch2DynamicReasonMessagesZh`
(`src/features/launch2/launch2-dynamic.ts`):

| reasonCode                                   | 文案                             |
| -------------------------------------------- | -------------------------------- |
| `LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED`      | 外盘路由未配置，暂不可交易       |
| `LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH`       | 外盘路由校验未通过，暂不可交易   |
| `LAUNCH2_DYNAMIC_ROUTER_MANAGER_MISMATCH`    | 外盘路由与池子不匹配，暂不可交易 |
| `LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED`           | 外盘池子正在同步，请稍后再试     |
| `LAUNCH2_DYNAMIC_HOOK_MISMATCH`              | 外盘池子校验未通过，暂不可交易   |
| `LAUNCH2_DYNAMIC_HOOK_NOT_INITIALIZED`       | 外盘池子尚未初始化               |
| `LAUNCH2_EXACT_OUT_UNSUPPORTED`              | 该池子只支持按支付金额交易       |
| `LAUNCH2_DYNAMIC_POOL_NOT_APPLICABLE`        | 该项目的外盘没有奖励轮次         |
| `LAUNCH2_DYNAMIC_ROUND_INVALID`              | 轮次编号无效                     |
| `LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED`        | 池子拒绝了这个交易入口           |
| `LAUNCH2_DYNAMIC_SWAP_UNSUPPORTED`           | 池子不支持这种交易方式           |
| `LAUNCH2_DYNAMIC_HOOK_BUSY`                  | 池子正忙，请稍后重试             |
| `LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED`           | 本轮还没有结束，结束后才能领取   |
| `LAUNCH2_DYNAMIC_ALREADY_CLAIMED`            | 本轮奖励已经领取过               |
| `LAUNCH2_DYNAMIC_CLAIM_TRANSACTION_CONFLICT` | 这次领取已经记录了另一笔交易     |
| `LAUNCH2_DYNAMIC_NOTHING_TO_CLAIM`           | 本轮没有可领取的奖励             |
| `LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND`     | 找不到这次领取请求               |

Server switches (all default off): `HOOKS_LAUNCH_HOOK_KIND` (officialTax),
`LAUNCH2_DYNAMIC_ROUTER_ADDRESS` / `_CODE_HASH`, `LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS` (API);
`LAUNCH2_DYNAMIC_FACTORY_ADDRESS` / `_CODE_HASH` (API: new Hooks launches with
`HOOKS_LAUNCH_HOOK_KIND=loopDynamic`, Decision 0132; worker: indexing and the deployment
executor), `LAUNCH2_DYNAMIC_POKE_*` (worker). With them
unset there are no `loopDynamic` instances and every `…/dynamic-pool` answer is `not_applicable`.

Decision 0133: the LoopDynamic Factory pair alone is enough to configure launch2 — without
`HOOKS_LAUNCH_FACTORY_ADDRESS` / `_CODE_HASH` the routes still answer, capability `launch2` is
not held back, and the worker lane indexes the LoopDynamic Factory (+ `LAUNCH2_LEGACY_FACTORIES`).
`LAUNCH2_FACTORY_NOT_CONFIGURED` now means **neither** the OfficialTax nor the LoopDynamic pair
is configured. Nothing in the wire format changes.

### 3.14 运营列表隐藏（Decision 0163，S245）

运营可在后台把实例设为「列表隐藏」（链上事实不变、不改名）。**线上格式不变：App 暂不下发 `listing`**（已发布 App 的 strict codec 遇未知键会整页 invalidPayload）；以后需要时作为可选键随移动端一起发。

- 列表（任何 `stage`，含已毕业）、`GET /v2/launch2/overview` 的计数与动态、`GET /public/v1/meme`、广场时间线 / 置顶里关于该实例的事件帖（buy / claim / graduation / system），都**不再出现**隐藏实例。
- 按 id 直达仍可读：详情、quote、pool、dynamic-pool、buybacks、`/v2/launch2/me/positions`、`GET /v2/square/posts/{postId}`；用户 opinion 帖照常显示。持有人从持仓 / 分享链接进入照常可看、可交易。
- App 无需任何改动、无新错误码。（官网 `GET /public/v1/meme/{id}` 另有 `instance.listing`。）

### 3.13 `GET /v2/launch2/overview`（Decision 0139，S181）

发射台整页（docs/32 §7.1 实时流、§7.5 战绩条）。鉴权与 headers 同 §3.1；无 query（带任何 query → `400`）；
`Cache-Control: no-store`。只读已索引的读模型，**不读链**；可见范围与 §3.1 列表相同（已激活或 hold 的实例）。

```json
{
  "activity": [
    {
      "kind": "curve_buy",
      "instanceId": "8a0c…",
      "ticker": "DOGE",
      "name": "Doge on LOOP",
      "logoUrl": "https://…/doge.png",
      "actor": "0x1d2f…9b",
      "account": {
        "publicProfileId": "3f0c…",
        "displayName": "frog",
        "avatarRef": null
      },
      "amountUsd1": "20",
      "at": "2027-01-15T08:00:40.000Z",
      "transactionHash": "0xabab…"
    },
    {
      "kind": "graduated",
      "instanceId": "8a0c…",
      "ticker": "DOGE",
      "name": "Doge on LOOP",
      "logoUrl": null,
      "actor": null,
      "account": null,
      "amountUsd1": null,
      "at": "2027-01-15T07:59:00.000Z",
      "transactionHash": "0xcdcd…"
    }
  ],
  "stats": {
    "liveCount": 8,
    "mintingCount": 2,
    "priorityCount": 1,
    "curveCount": 5,
    "upcomingCount": 3,
    "graduatedTotal": 4,
    "graduatedThisWeek": 1,
    "buybackUsd1Total": "1250.5",
    "nftMintedTotal": 128
  },
  "observedAt": "2027-01-15T08:00:41.000Z",
  "contractVersion": "2.0"
}
```

`activity`：最多 30 条，按 `at` 倒序（同秒按区块、日志序），跨实例合并。

| `kind`            | 含义                                       | `actor`                                             | `amountUsd1`               |
| ----------------- | ------------------------------------------ | --------------------------------------------------- | -------------------------- |
| `curve_buy`       | 内盘买入；毕业后官方池用户买入（不含回购） | 买方全地址；外盘未归属（Decision 0132 匿名）为 null | 实付 USD1（内盘含 10 %税） |
| `curve_sell`      | 内盘卖出；毕业后官方池用户卖出             | 同上                                                | 实收 USD1（扣税后）        |
| `nft_mint`        | 铸造项目 NFT                               | 付款地址                                            | `"100"`                    |
| `graduated`       | 毕业                                       | null                                                | null                       |
| `buyback`         | 回购成交                                   | null                                                | 花费 USD1                  |
| `round_activated` | LoopDynamic 奖励轮次开启                   | null                                                | null                       |
| `reward_claimed`  | LoopDynamic 奖励领取                       | 领取地址                                            | 领取 USD1                  |

- `actor` 是 0x 全地址，App 自己缩短；null 显示「有人」（交易）或不显示主语（平台动作）。
- `account`（决策 0162）：`actor` 背后的 LOOP 账户，规则同 §3.2 `recentTrades[].account`；有值时显示头像 / 名字并可点开资料页，`actor` 为 null 时恒为 null。
- 点一条 → `instanceId` 的项目页。`transactionHash` 可为 null（老数据未存哈希的毕业行）。

`stats`：

- 阶段数按与 §3.1 **同一个**推导函数在应答时按时钟重算：`mintingCount` = `nft_sale`、`priorityCount` =
  `priority`、`curveCount` = `public`、`upcomingCount` = `upcoming`、`graduatedTotal` = `graduated`；
  `liveCount` = 前三者之和。`snapshot_pending` / `paused` / `closed_no_holders` 不计入任何计数。
- `graduatedThisWeek`：`graduated` 且 `graduatedAt` ≥ 服务器 UTC 本周一 00:00。
- `buybackUsd1Total`：所有可见实例已执行回购的 USD1 合计（十进制字符串）；`nftMintedTotal`：已索引铸造数合计。
- 空库：`activity: []`，计数全 0，`buybackUsd1Total: "0"`。
- 错误：`400`（带 query）、`401`、`503` 同 §5。

## 4. Errors (seven-field envelope; `detailsSafe.reasonCode` names the rule)

| HTTP | code                             | reasonCode                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | — (bad query / body / cursor)                                                                                                                                                                                                                                                                                                                                                                                          |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 403  | `POLICY_BLOCKED`                 | `LAUNCH2_NOT_IN_SNAPSHOT`; `LAUNCH2_COUNTERPARTY_NOT_INSTANCE` (Decision 0117); canary: `ASSET_NOT_IN_CANARY_ALLOWLIST`, `CANARY_CEILING_EXCEEDED`, `CANARY_DAILY_CEILING_EXCEEDED` (as Decision 0065). The static `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST` no longer applies to launch2                                                                                                                                 |
| 404  | `NOT_FOUND`                      | `LAUNCH2_INSTANCE_NOT_FOUND`; a foreign walletId has no reason; 0131: `LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND`                                                                                                                                                                                                                                                                                                         |
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
