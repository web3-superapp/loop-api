# Frontend contract: MEME v2 (`launch2`) — Decision 0114

Status: implemented on `feat/S134-launch2-read-model`; Development / BSC Testnet (chain 97)
only. Evidence: anvil end-to-end (`test/launch2-anvil.integration.test.ts`); no BSC Testnet
run yet. Project-side flow (资料 → 审核 → 签名 → 部署 → 激活) stays on the S125 routes
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

| `stage`            | Meaning                                 | `nextChangeAt` | App                            |
| ------------------ | --------------------------------------- | -------------- | ------------------------------ |
| `upcoming`         | Activated, NFT sale not open yet        | sale start     | 即将开售 · 倒计时              |
| `nft_sale`         | NFT sale (604,800 s)                    | sale end       | NFT 发售中 · 剩余 d h m        |
| `snapshot_pending` | Sale over, holder list not published    | `null`         | 名单生成中                     |
| `priority`         | Snapshot holders only, 3,600 s          | round end      | 提前购 · 持有人优先 · 剩余 m s |
| `public`           | Public curve until sold out             | `null`         | 公开内盘                       |
| `graduated`        | Sold out → official pool (either round) | `null`         | 已毕业 · 官方池交易中          |
| `paused`           | Integrity hold (`holdReason`)           | `null`         | 已暂停 + reason                |

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
      "nextChangeAt": "2027-01-23T07:00:00.000Z",
      "holdReason": null,
      "activatedAt": "2027-01-15T07:00:00.000Z",
      "nftSale": {
        "priceUsd1": "100",
        "soldCount": "2",
        "startAt": "2027-01-16T07:00:00.000Z",
        "endAt": "2027-01-23T07:00:00.000Z"
      },
      "curve": {
        "saleSupply": "800000000",
        "soldSupply": "0",
        "soldBps": 0,
        "reserveUsd1": "0",
        "graduationReserveUsd1": "133333.332",
        "reserveBps": 0,
        "priceUsd1": "0.000041666666625"
      },
      "graduatedAt": null
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

List row: 内盘进度 = `curve.soldBps` (已售 / 8 亿), 毕业进度 = `curve.reserveBps`
(储备 / 133,333.332), 当前价 = `curve.priceUsd1`.

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
      "nftSaleSeconds": 604800,
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
      "signers": ["0x…", "0x…"]
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
      "latest": null
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
refused with 503 until an operator resolves it). `graduation` once graduated:
`{graduatedAt, officialPoolId, hookAddress, lpFee: 2500, tickSpacing: 60,
officialPoolTaxBps: 200, transactionHash}` (v4 pools have an id, not an address).

### 3.3 `GET /v2/launch2/instances/{instanceId}/quote?side=buy|sell&amount=&walletId=&slippageBps=`

`amount`: buy = USD1 in (tax included); sell = MEME in. `slippageBps` 0–5000 (default 100).

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
    "priceBeforeUsd1": "0.000041666666625",
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
  800M) | `balance` (wallet USD1 / MEME) | `sold_supply` (sell) | `closed`.
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
The lane shows the mint in `viewer.nft` after indexing; there is no report route.

### 3.5 `POST /v2/launch2/instances/{instanceId}/trade/prepare`

Body `{"walletId", "side": "buy"|"sell", "amount", "minOut", "deadline"}` from §3.3. `201`: the
same resource with `kind: "buy"|"sell"`, `contractAddress` = curve,
`calldata` = `buy(amountInMax, minMemeOut, deadline, proof)` / `sell(memeIn, minUsd1Out, deadline)`,
`approval` for USD1 (buy) or MEME (sell) when short. The contract refunds unused USD1.

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
      "minMemeOut": "148500",
      "referencePriceUsd1": "0.00066…",
      "spotPriceUsd1": "0.00066…",
      "executedAt": "…",
      "transactionHash": "0x…",
      "blockNumber": "…"
    }
  ],
  "nextCursor": null,
  "contractVersion": "2.0"
}
```

`nextOrderBlockedReason`: `null` | `BUYBACK_PAUSED` | `BUYBACK_NOT_GRADUATED` |
`BUYBACK_NO_BUDGET` | `BUYBACK_PROTECTION_BLOCKED` (reference / spot / principal protection
would refuse now) | `BUYBACK_PRICE_SOURCE_UNAVAILABLE`. Refused attempts are not listed
(they revert without a log). `live: null` + `liveUnavailable.reasonCode` when the chain read
fails. Copy: 「回购不等于销毁」 in ⓘ.

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
      "lastActivityAt": "…"
    }
  ],
  "contractVersion": "2.0"
}
```

`curve.net` is curve bought − sold; MEME moved wallet-to-wallet after graduation is not tracked.

## 4. Errors (seven-field envelope; `detailsSafe.reasonCode` names the rule)

| HTTP | code                             | reasonCode                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                | — (bad query / body / cursor)                                                                                                                                                                                                                                                             |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | —                                                                                                                                                                                                                                                                                         |
| 403  | `POLICY_BLOCKED`                 | `LAUNCH2_NOT_IN_SNAPSHOT`; canary: `ASSET_NOT_IN_CANARY_ALLOWLIST`, `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`, `CANARY_CEILING_EXCEEDED`, `CANARY_DAILY_CEILING_EXCEEDED` (as Decision 0065)                                                                                                 |
| 404  | `NOT_FOUND`                      | `LAUNCH2_INSTANCE_NOT_FOUND`; a foreign walletId has no reason                                                                                                                                                                                                                            |
| 409  | `DATA_STALE`                     | `LAUNCH2_STAGE_MISMATCH` (`stage`), `LAUNCH2_SELL_NOT_OPEN`, `LAUNCH2_SOLD_OUT`, `LAUNCH2_QUOTA_EXHAUSTED`, `LAUNCH2_INSTANCE_PAUSED` (`holdReason`), `LAUNCH2_NFT_ALREADY_MINTED`, `LAUNCH2_PRICE_MOVED`                                                                                 |
| 409  | `QUOTE_EXPIRED`                  | `LAUNCH2_QUOTE_EXPIRED`                                                                                                                                                                                                                                                                   |
| 409  | `INSUFFICIENT_BALANCE`           | `LAUNCH2_USD1_BALANCE_INSUFFICIENT`, `LAUNCH2_MEME_BALANCE_INSUFFICIENT`, `LAUNCH2_GAS_INSUFFICIENT`                                                                                                                                                                                      |
| 409  | `IDEMPOTENCY_CONFLICT`           | —                                                                                                                                                                                                                                                                                         |
| 422  | `VALIDATION_FAILED`              | `LAUNCH2_AMOUNT_INVALID`, `LAUNCH2_AMOUNT_ABOVE_MAX`, `LAUNCH2_DEADLINE_TOO_FAR`, `LAUNCH2_QUOTE_ZERO`, `LAUNCH2_WALLET_NOT_EMBEDDED`                                                                                                                                                     |
| 503  | `CAPABILITY_UNAVAILABLE`         | `LAUNCH2_FACTORY_NOT_CONFIGURED`, `LAUNCH2_CHAIN_NOT_CONFIGURED`, `LAUNCH2_REPOSITORY_UNAVAILABLE`, `LAUNCH2_RUNTIME_UNAVAILABLE`, `LAUNCH2_CHAIN_READ_FAILED`, `LAUNCH2_WALLETS_UNAVAILABLE`, `LAUNCH2_WRITES_DISABLED`, `LAUNCH2_MAINNET_SIGNING_CLOSED`, `LAUNCH2_SNAPSHOT_UNVERIFIED` |

## 5. Unavailable behaviour

Never fabricate a stage, price, or list: a 503 shows the module unavailable with retry; an
empty `instances` list is the empty state (the lane has indexed nothing yet). `viewer: null`
means no wallet, not zero holdings.

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
