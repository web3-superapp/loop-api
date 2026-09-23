# 前端联调：V2 链数据、钱包只读与自选（S5a / D10 + D12 + D13）

本文是 `chain`、`wallet`、`watchlist` 三个模块（决策 0033）的前端交接契约。
权威机器契约为 `openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、
错误体七字段）沿用 `docs/frontend-v2-session-api.md` 与
`docs/api-v2-conventions.md`。

覆盖页面：`wallet`、`networth`、`asset`、`receive`、`wallets`、`tx-history`、
`networks`、`watchlist-edit`。行情（价格、K 线、成交、持有人）属于 S5b，本步
一律 `unavailable`。

## 1. Base URL、启用条件与 headers

- Development：`https://api-dev.quant-dinger.cc`；本机 `http://127.0.0.1:3000`
  （或 `PORT` 指定端口）。
- 后端 `V2_MODULES_ENABLED` 必须分别包含 `chain`、`wallet`、`watchlist`。未启用
  的模块，其路径全部返回 `404 NOT_FOUND`（V2 错误体），且不会校验 Bearer。
- 前端必须先读 `GET /v2/meta/capabilities`：

| capabilityId | `available` 条件                                                              | UI 含义                              |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------ |
| `bscRead`    | `chain` 启用 + 至少一个 RPC 端点 + registry 仓储 + `eth_chainId == 56` 已实测 | 链上事实（余额、活动、网络健康）可用 |
| `walletRead` | `wallet` 启用 + Privy 凭据 + 钱包仓储 + cursor 密钥                           | 钱包清单、活跃钱包切换、收款可用     |
| `watchlist`  | `watchlist` 启用 + 自选仓储 + registry 仓储                                   | 自选编辑可用                         |

`bscRead` 的 `reasonCode` 直接决定 `networks` 页的文案：

| reasonCode                       | 含义                                        |
| -------------------------------- | ------------------------------------------- |
| `BSC_RPC_NOT_CONFIGURED`         | 未配置任何 RPC 端点                         |
| `BSC_CHAIN_RUNTIME_UNAVAILABLE`  | 配了端点但后端依赖（registry 仓储）未组装   |
| `BSC_CHAIN_VERIFICATION_PENDING` | 端点已配置，chainId 校验尚未完成            |
| `BSC_RPC_UNREACHABLE`            | 端点不可达                                  |
| `BSC_CHAIN_ID_MISMATCH`          | 端点返回的不是 chain 56——**必须整页不可用** |

`deferred` 表示模块未启用。任何非 `available` 的情况都不要调用对应接口，也不要
回退 fixture 或显示 0。

- 读接口 header：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

- 本模块**没有** `Idempotency-Key` 写接口。`PUT /v2/wallets/active` 与
  `PUT /v2/watchlist` 都是版本 CAS 写，带 `Idempotency-Key` 返回
  `400 INVALID_REQUEST`（决策 0030）。未知 `X-Loop-*` header、未知 query、未知
  body 字段一律 `400 INVALID_REQUEST`。
- 所有响应 `Cache-Control: no-store`；`X-Request-ID` 为服务端生成的 UUID，错误体
  `correlationId` 与之相等。

## 2. 数值与标识约定

- **金额一律字符串**。`rawValue` 是最小单位整数字符串，`displayBalance` /
  `spendableBalance` / `displayValue` 是精确十进制字符串。前端用 `Decimal`
  解析，禁止 `double`/`num.parse`。
- **区块高度是字符串**（`blockNumber`、`lastBlockNumber`），可能超过 2^53。
- `assetId` 是规范 CAIP：`eip155:56:<0x 小写地址>`，原生资产
  `eip155:56:native`。**ticker/symbol 永远不是标识**，不要用它拼路由或做 key。
- `walletId` 是不透明 UUIDv4。钱包地址是公开链上事实，`wallets`、`receive`、
  `balances` 三个响应都会下发完整地址；**但地址永远不是账号 ID**，任何请求只能
  用 `walletId` 指向钱包，服务端不接受客户端选择的地址。截断显示由前端做。
- 时间是带时区的 RFC 3339 字符串。

## 3. `GET /v2/chain/status` → `networks` 页

未配置 RPC 端点时返回 `503 CAPABILITY_UNAVAILABLE`（整页不可用）。配置后返回：

```json
{
  "chain": {
    "chainId": "eip155:56",
    "name": "BNB Smart Chain",
    "reference": 56,
    "nativeAssetId": "eip155:56:native",
    "confirmations": 15,
    "reorgDepthBlocks": 64
  },
  "rpc": {
    "status": "available",
    "reasonCode": null,
    "verification": "verified",
    "head": {
      "blockNumber": "120628164",
      "blockHash": "0xa1373bd2…",
      "observedAt": "2026-09-08T05:12:07.738Z"
    },
    "endpoints": [
      {
        "endpointRef": "rpc-2bd52ca6d267",
        "label": "bsc-rpc.publicnode.com",
        "status": "healthy",
        "latencyMs": 515,
        "blockNumber": "120628163",
        "blockLagBlocks": 0,
        "chainVerification": "verified",
        "observedAt": "2026-09-08T05:12:07.039Z"
      }
    ]
  },
  "indexer": [
    {
      "lane": "erc20_transfer",
      "status": "unavailable",
      "reasonCode": "BSC_INDEXER_NOT_STARTED",
      "lastBlockNumber": null,
      "lastBlockHash": null,
      "lagBlocks": null,
      "reorgCount": null,
      "updatedAt": null
    }
  ],
  "registry": { "readableAssetCount": 1, "registeredPoolCount": 0 },
  "contractVersion": "2.0"
}
```

- `launchChain`（S9 / 决策 0038，optional）：`launch` 链槽位与 `primary` 相同时**该键
  缺席**（上面的文档即完整响应）；后端 `LAUNCH_CHAIN_ID=97` 时在 `registry` 之后多出
  测试网自己的健康投影，字段与语义见 `docs/frontend-v2-chain-api.md`。
  `chain`/`rpc`/`indexer`/`registry` 永远只描述 `eip155:56`。
- `endpointRef` 是不可逆的稳定引用（`rpc-<12 位十六进制>`），**只做列表 key 与运维关联，
  不上屏**（走查 D-17）。行标题用 `label`（S27c / 决策 0049）：RPC URL 的主机名，例如
  `bsc-rpc.publicnode.com`，不含协议、端口、路径、query 与任何密钥。**后端永远不下发
  完整 RPC URL**，前端不要拼接或猜测端点地址。
- `status`：`healthy` / `degraded`（延迟 > 1500ms、落后 > 3 块，或 chainId 不符）
  / `unreachable`。`degraded` 与 `unreachable` 对应原型的 `异常` badge。
- 只列 BSC 一条网络。自定义 RPC 与测试网**不显示**（不是 unavailable 占位）。
- `indexer[]` 自 S5b 起有两条 lane：`erc20_transfer`（钱包活动）与 `pool_event`
  （行情成交/派生 K 线）；`lane` 字段是枚举，不要写死为常量。
- lane 的 `status` **只有两态**：`unavailable`（从未运行，`BSC_INDEXER_NOT_STARTED`）
  与 `available`（存在 checkpoint）。后端没有"落后阈值"：S5 联调实测 lane 落后
  1456–1936 块时仍是 `available`。`networks` 页不要把 `available` 当成"数据是
  新的"，必须用 `lagBlocks`（head − checkpoint；head 读不到时为 `null`）显示
  "落后 N 块"。

## 4. `GET /v2/assets/{assetId}` → `asset` 页头部

```json
{
  "asset": {
    "assetId": "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    "chainId": "eip155:56",
    "address": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    "symbol": "WBNB",
    "name": "Wrapped BNB",
    "decimals": 18,
    "status": "pending",
    "source": {
      "kind": "chain_call",
      "blockNumber": "120628195",
      "verifiedAt": "2026-09-08T05:12:21.926Z"
    },
    "updatedAt": "2026-09-08T05:12:21.926Z"
  },
  "capability": {
    "viewable": true,
    "swappable": false,
    "value": "viewable",
    "reasonCode": "SWAP_MODULE_NOT_DELIVERED"
  },
  "contractVersion": "2.0"
}
```

- `symbol`/`name`/`decimals` 只来自链上调用，`source.blockNumber` 是观测高度。
- **`swappable` 在 D15 之前恒为 `false`，Token 页的 Swap 入口必须隐藏。**
- `capability.value` 为 `temporarily_unavailable` 时链读不可用（registry 事实
  仍可显示，但不要展示任何"当前"链上数字）；`blocked` 时整个资产不可展示。
- 不在 registry 的 `assetId` → `404 NOT_FOUND`；非 56 链 → `422 CHAIN_MISMATCH`。

## 5. `GET /v2/wallets` 与 `PUT /v2/wallets/active` → `wallets` 页

```json
{
  "wallets": [
    {
      "walletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "provider": "privy",
      "address": "0x00000000000000000000000000000000000000a1",
      "kind": "embedded",
      "status": "active",
      "isActive": true,
      "firstSeenAt": "2026-09-08T00:00:00.000Z",
      "lastSeenAt": "2026-09-08T00:00:00.000Z"
    }
  ],
  "activeWalletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "source": { "provider": "privy", "observedAt": "2026-09-08T05:12:07.738Z" },
  "contractVersion": "2.0"
}
```

- 首次调用会把 Privy 报告的钱包写入 LOOP 并分配 `walletId`；Privy 不再报告的
  钱包变成 `status: "archived"`（不会删除），`isActive` 强制为 `false`。
- **首次同步即自动选中活跃钱包**（S5 联调发现 2）：账号没有任何活跃钱包时，
  同步末尾按 `kind asc, firstSeenAt asc, walletId asc` 选第一条，即最早的
  `embedded` 钱包。因此全新账号第一次 `GET /v2/wallets` 的 `activeWalletId`
  就已经是那个嵌入式钱包，**不是 `null`**；`wallets` 页切换时必须把这个值作为
  `expectedActiveWalletId`，传 `null` 会得到 `409 VERSION_CONFLICT`。
- `kind` 是原型里"Privy 嵌入式钱包 / 已连接的外部钱包"两段的依据。
- `address` 是完整小写地址（主代理裁决 2026-09-08）。`wallets` 页的截断显示
  由前端处理；不要把地址当 key 或路由参数。
- Privy 不可达 → `503 PROVIDER_DISCONNECTED`（可重试），不要显示"没有钱包"。
- **`source.observedAt` 是"后端真正读到 Privy 的时刻"，不是本次响应时刻**
  （决策 0063）。后端对同一个 Privy 用户的钱包清单做 30s 复用：窗口内再次调用
  不打 Privy，`observedAt` 原样返回上一次的观测时刻（实测 694ms → 4–21ms）。
  钱包列表本身每次都从数据库重建，所以 `PUT /v2/wallets/active` 之后立刻调用
  `GET /v2/wallets` 一定能看到新的 `activeWalletId`；只有"账号下有哪些钱包"
  这件事最多滞后 30s。用户在 Privy 新绑一个钱包后，前端若需要立即看到，
  可提示用户稍后重试，不要轮询。

切换活跃钱包：

```http
PUT /v2/wallets/active
{"walletId": "<uuid>", "expectedActiveWalletId": "<当前活跃 uuid 或 null>"}
```

返回与 `GET /v2/wallets` 相同的结构。并发切换 → `409 VERSION_CONFLICT`
（请重新拉取清单再试）；`walletId` 不属于本账号或已归档 → `404 NOT_FOUND`；
带 `Idempotency-Key` → `400 INVALID_REQUEST`。

## 6. `GET /v2/wallets/{walletId}/balances` → `wallet` / `networth` / `asset` 页

```json
{
  "walletId": "0b2c1d3e-…",
  "snapshot": {
    "blockNumber": "120628164",
    "blockHash": "0xa1373bd2…",
    "observedAt": "2026-09-08T05:12:07.738Z",
    "confirmations": 15
  },
  "gasReservePolicy": {
    "configVersion": "walletGasReserveV1",
    "nativeReserveRaw": "5000000000000000",
    "nativeReserve": "0.005"
  },
  "balances": [
    {
      "assetId": "eip155:56:native",
      "symbol": "BNB",
      "name": "BNB",
      "decimals": 18,
      "address": null,
      "logo": {
        "status": "available",
        "url": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png",
        "source": "trustwallet",
        "observedAt": null
      },
      "balance": {
        "status": "available",
        "rawValue": "7000000000000000000",
        "displayBalance": "7",
        "availableBalance": "7",
        "spendableBalance": "6.995",
        "gasReserve": "0.005"
      },
      "pending": {
        "status": "available",
        "rawValue": "0",
        "displayValue": "0"
      },
      "valuation": {
        "status": "available",
        "priceSource": "dexscreener",
        "fetchedAt": "2026-09-08T07:52:56.738Z",
        "quality": "proxied",
        "reasonCode": null,
        "proxyAsset": "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        "priceUsd": "747.39",
        "valueUsd": "5231.73"
      },
      "crossCheck": {
        "source": "privy",
        "status": "matched",
        "reasonCode": null
      }
    }
  ],
  "netWorth": {
    "status": "available",
    "valuationCurrency": "USD",
    "valueUsd": "6352.815",
    "unavailableCount": 0,
    "quality": "fresh",
    "priceSource": "dexscreener",
    "asOf": "2026-09-08T07:52:56.738Z",
    "isSpendable": false
  },
  "contractVersion": "2.0"
}
```

每行必填 `logo`（决策 0072，形状、主机白名单与客户端回退规则见
`docs/frontend-v2-market-api.md` §2a）：代币行在估值用到的 DexScreener 交易对带
`info.imageUrl` 时是 `{status:"available", source:"dexscreener", url, observedAt}`，
否则是 Trust Wallet 规则 URL（`source:"trustwallet"`, `observedAt: null`）；原生 BNB
永远是规则 URL（不借 WBNB 的图）。`launchChain.nativeBalance` 也有 `logo`：Launch 槽
指向 `eip155:97` 时是 `{status:"unavailable", reasonCode:"TOKEN_LOGO_CHAIN_UNSUPPORTED"}`。
加载失败 → monogram，不重试。

代币行的 `valuation`（S5b 接入行情后）：

```json
"valuation": {
  "status": "available",
  "priceSource": "dexscreener",
  "fetchedAt": "2026-09-08T07:52:56.738Z",
  "quality": "fresh",
  "reasonCode": null,
  "proxyAsset": null,
  "priceUsd": "747.39",
  "valueUsd": "1121.085"
}
```

- 所有余额取自**同一个 `snapshot.blockNumber`**。UI 必须把这个高度和
  `observedAt` 显示出来，不要混用不同时刻的数字。
- 五个口径互不相等，不要互相推导：`displayBalance`（链上余额）、
  `availableBalance`（本步 = display）、`spendableBalance`（= display −
  `gasReserve`，只有原生资产有保留量）、`gasReserve`、`pending`（indexer 里
  未确认的**入账**，不计入可用）。保留量由后端 `WALLET_GAS_RESERVE_BNB` 配置
  （默认 0.005 BNB），随响应下发 `gasReservePolicy`，前端不要写死。
- `pending.status === "unavailable"` + `BSC_INDEXER_NOT_STARTED` 表示 indexer
  未运行，显示"待确认金额不可用"，不要显示 0。
- **每个可读 registry 资产恒定一行**。数值字段收在判别联合 `balance` 下：
  `{status:"available", rawValue, displayBalance, availableBalance,
spendableBalance, gasReserve}` 或 `{status:"unavailable", reasonCode}`。
  单个资产的链上调用失败时该行仍然存在且 `balance.status === "unavailable"`
  ——**"读不到"和"这个钱包没有该资产"必须区分**，不要把它当 0。
- `crossCheck` 只是与 Privy 对账：`matched` / `unaligned`（数值不一致，但
  Privy 不下发它读的区块，无法归因）/ `disputed`（保留给会上报区块的来源）/
  `unavailable`（外部钱包无 Privy wallet ID、代币无法映射、精度无法对齐、
  或 Privy 余额读取失败/超时 → `PRIVY_BALANCE_CROSS_CHECK_FAILED`）。
  `blockDelta` 为两次观测的区块差，来源不上报区块时为 `null`。
  **任何 crossCheck 结果都不改变 `balance` 里的 RPC 数值**，UI 最多给一个
  "数据源尚未对齐"的提示。
  2026-09-21 起（决策 0063）后端修正了 Privy 余额查询（此前缺 `asset` 参数，
  Privy 一律返回 400），原生行因此可能第一次出现 `matched`。非原生行仍然是
  `unavailable` + `PRIVY_ASSET_MAPPING_UNAVAILABLE`，不变。
- `valuation`（每行）：只用该资产自己的 DexScreener 价格（以其为 base 的最深
  交易对），`quality: fresh|stale`（stale 透传 `reasonCode`），
  `valueUsd = displayBalance × priceUsd`（精确十进制字符串）。原生 BNB 行用 WBNB
  价格代理：`quality: proxied` + `proxyAsset`（WBNB 的 assetId），UI 标注"以 WBNB
  计价"；余额读不到 → `BALANCE_UNAVAILABLE`；market 运行时未组装 →
  `MARKET_RUNTIME_UNAVAILABLE`。
- `netWorth`：全部行都有估值（含 proxied）才是 `available`，否则 `partial` + `unavailableCount`
  （`valueUsd` 只是已估值行合计，**不要**把它当总资产）；`valuationCurrency: USD`，
  `asOf` 是最新的 Provider 抓取时间，`quality` 有任一行 stale 即 stale；
  **`isSpendable: false`——净值是展示信息，不是余额**。`networth` 页的 24h 涨跌、
  图表仍无后端，显示 unavailable。
- 链读不可用（未配置 RPC、端点不可达、chainId 不符）→ `503
CAPABILITY_UNAVAILABLE`。后端**不会**回放历史快照当成当前余额。

### 6.1 `launchChain`：Launch 链槽位上的 tBNB 余额（S9 / 决策 0038）

后端 `LAUNCH_CHAIN_ID` 未设置或为 `56` 时**没有这个键**（响应与 S5/S5b 逐字节相同），
钱包页不显示 Launch 区块；为 `97` 时响应在 `netWorth` 之后、`contractVersion` 之前多一个
optional 键 `launchChain`：

```json
{
  "launchChain": {
    "chainId": "eip155:97",
    "availability": "available",
    "reasonCode": null,
    "nativeBalance": {
      "assetId": "eip155:97:native",
      "symbol": "tBNB",
      "decimals": 18,
      "rawValue": "2500000000000000000",
      "displayBalance": "2.5",
      "availableBalance": "2.5",
      "spendableBalance": "2.495",
      "gasReserve": "0.005",
      "snapshot": {
        "blockNumber": "52000000",
        "blockHash": "0x9999…",
        "observedAt": "2026-09-09T10:45:05.000Z",
        "confirmations": 5
      }
    }
  }
}
```

- 只有原生币（tBNB）一条，来自一次 `eth_getBalance`；**没有** 97 的资产 registry、
  ERC-20 余额、`pending`、`valuation`、`crossCheck`。`spendableBalance` /
  `gasReserve` 规则与主链一致（复用 `WALLET_GAS_RESERVE_BNB`，随 `gasReservePolicy`
  下发，不要写死）。
- `availability: "unavailable"` 时 `nativeBalance` 为 `null`，`reasonCode` 为：

| reasonCode                        | 含义                                           |
| --------------------------------- | ---------------------------------------------- |
| `LAUNCH_CHAIN_RPC_NOT_CONFIGURED` | 后端配置了 97 但没有测试网 RPC                 |
| `LAUNCH_CHAIN_RPC_UNREACHABLE`    | 测试网端点全部不可达，**或 3s 内未答**（0063） |
| `LAUNCH_CHAIN_ID_MISMATCH`        | 端点返回的不是 chain 97——Launch 区块整块不可用 |
| `BSC_BALANCE_CALL_FAILED`         | 链已校验但 `eth_getBalance` 本身失败           |

`LAUNCH_CHAIN_VERIFICATION_PENDING` **只出现在 `GET /v2/chain/status.launchChain`**，
不会出现在 balances：余额读取本身会触发 chainId 校验，校验结果只能是已核验、
不符或不可达三者之一。

- `nativeBalance.snapshot.confirmations` 是后端对测试网槽位配置的**策略确认数**
  （`LAUNCH_BSC_CONFIRMATIONS`，默认 5），语义与主链 `snapshot.confirmations` 相同——
  表示"多少个确认后视为最终"，**不是**该快照区块已经获得的确认数。

- 测试网槽位失败**不会**让主链 balances 变成 503：`balances[]`、`snapshot`、
  `netWorth` 照常下发。钱包页 Launch 区块单独显示 unavailable。
- 决策 0063 起测试网槽位与主链读取**并行**，并有 3000ms 上限：超时按
  `LAUNCH_CHAIN_RPC_UNREACHABLE` 下发（不会编造数值，也不会拖慢整页）。
  这一格偶发 unavailable 属正常，UI 不要因此阻塞或重试整页。
- 行情、Watchlist、Swap、Send 页面永远不显示 97 的任何数据；`walletRead` /
  `bscRead` capability 只描述主链。

## 7. `GET /v2/wallets/{walletId}/activity` → `tx-history` 页

query：`cursor`（不透明）或 `limit`（1–50，默认 25），二者互斥。

```json
{
  "walletId": "0b2c1d3e-…",
  "items": [
    {
      "assetId": "eip155:56:0xbb4c…",
      "symbol": "WBNB",
      "decimals": 18,
      "direction": "in",
      "counterpartyAddress": "0x…",
      "rawValue": "1500000000000000000",
      "displayValue": "1.5",
      "transactionHash": "0x…",
      "logIndex": 3,
      "blockNumber": "120628064",
      "blockHash": "0x…",
      "confirmations": 101,
      "status": "confirmed",
      "observedAt": "2026-09-08T00:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "freshness": {
    "indexerBlockNumber": "120628771",
    "headBlockNumber": "120628804",
    "lagBlocks": 33,
    "observedAt": "2026-09-08T05:16:56.199Z"
  },
  "nativeTransfers": {
    "status": "unavailable",
    "reasonCode": "NATIVE_TRANSFER_SCAN_NOT_SUPPORTED"
  },
  "crossChain": {
    "status": "unavailable",
    "reasonCode": "CROSS_CHAIN_ACTIVITY_NOT_SUPPORTED"
  },
  "contractVersion": "2.0"
}
```

- 只有 registry 资产的 **ERC-20** 转账。原生 BNB 转账与跨链在本步 unavailable，
  原型的"跨链"筛选段必须显示为不可用，不能显示空列表。
- `status`：`confirmed`（确认数 ≥ `confirmations`）/ `pending` / `reorged`。
  `reorged` 的行会保留并下发，前端应把之前显示过的该条标记为已回滚。
- indexer 从未运行 → `503 INDEXING_DELAYED`（不是空列表）。`freshness.lagBlocks`
  很大时应显示"数据落后 N 块"。
- `nextCursor` 与 `limit` 互斥：翻页只传 `cursor`。cursor 绑定账号/路由/钱包：
  过期、篡改、或把 A 钱包的 cursor 用到**自己**的另一个 `walletId` 上 →
  `400 INVALID_REQUEST`；**跨账号**（账号 B 拿账号 A 的 cursor 打 A 的
  `walletId`）→ `404 NOT_FOUND`，因为 `walletId` 先做不可枚举校验（S5 联调
  发现 4）。两种都不要重试，重新从 `limit` 拉第一页。

## 8. `GET /v2/wallets/{walletId}/receive` → `receive` 页

```json
{
  "walletId": "0b2c1d3e-…",
  "networks": [
    {
      "chainId": "eip155:56",
      "name": "BNB Smart Chain",
      "address": "0x00000000000000000000000000000000000000a1",
      "uri": "ethereum:0x00000000000000000000000000000000000000a1@56",
      "warningKey": "wallet.receive.bscOnly"
    }
  ],
  "contractVersion": "2.0"
}
```

- QR 由前端用 `uri`（EIP-681）渲染，后端不下发图片。
- **只有 BSC 一个 seg**，其余网络直接不列（不是 unavailable 占位）。
- `warningKey` 是本地化键，用于"只接收 BSC 网络资产"的警示文案。

## 9. `GET/PUT /v2/watchlist` → `watchlist-edit` 页

```json
{
  "version": 1,
  "updatedAt": "2026-09-08T05:12:50.038Z",
  "groups": [
    {
      "key": "mining",
      "name": "Mining",
      "items": [
        {
          "assetId": "eip155:56:0xbb4c…",
          "asset": {
            "symbol": "WBNB",
            "name": "Wrapped BNB",
            "decimals": 18,
            "status": "pending"
          },
          "logo": {
            "status": "available",
            "url": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/logo.png",
            "source": "trustwallet",
            "observedAt": null
          },
          "reasonCode": null
        }
      ]
    }
  ],
  "contractVersion": "2.0"
}
```

写入（整体替换，CAS）：

```http
PUT /v2/watchlist
{"expectedVersion": 1, "groups": [{"key": "mining", "name": "Mining",
  "items": [{"assetId": "eip155:56:0xbb4c…"}]}]}
```

- 约束：≤20 个分组，总计 ≤100 条；`key` 匹配 `^[a-z0-9][a-z0-9_-]{0,31}$`，
  组内 `assetId` 不重复；`name` 去空白后 1–40 个码位、不含控制字符。
- `expectedVersion` 不匹配 → `409 VERSION_CONFLICT`（重新 `GET` 后合并再试）。
  内容与当前完全一致的重试**不会**冲突，直接返回已提交资源（幂等）。
- 任一 `assetId` 不在 registry 或被 `blocked` → `422 VALIDATION_FAILED`，整个
  请求不写入。前端应在加入自选前先 `GET /v2/assets/{assetId}` 确认。
- 已入库但后来变得不可读的资产，`asset` 为 `null` 且
  `reasonCode: "ASSET_NOT_READABLE"`，行仍然列出（让用户能删掉它）。
- 每行必填 `logo`（决策 0072）：本接口不读行情事实，一律是 Trust Wallet 规则 URL
  （`source:"trustwallet"`, `observedAt:null`；原生 BNB 是 `…/smartchain/info/logo.png`）。
  形状与回退规则见 `docs/frontend-v2-market-api.md` §2a。
- **自选不是行情事实**：价格、涨跌幅要等 S5b 的 `market` 接口，本步不要显示。
- 该资源与冻结的 V1 `/v1/watchlist` **共用同一个版本号**，迁移是单向一次性的：
  - V2 的整体替换会覆盖遗留的 V1 行；
  - 迁移后 V1 `GET /v1/watchlist` 仍返回 200，但分组的 `items` 为空
    （V1 只能表示 `asset_key` 行），前端不要把它当"自选被清空"；
  - 迁移后 V1 `PUT /v1/watchlist` 一律返回 `409 version_conflict`，后端拒绝
    删除 V2 行。旧版客户端必须升级后走 V2，不要循环重试。

## 10. 错误码速查

| HTTP | code                             | 出现位置                                  | 前端动作                          |
| ---- | -------------------------------- | ----------------------------------------- | --------------------------------- |
| 400  | `INVALID_REQUEST`                | 未知字段、带 `Idempotency-Key`、坏 cursor | 修请求，不重试                    |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID` | 缺失或无效 Bearer                         | 重新走 Privy 登录                 |
| 404  | `NOT_FOUND`                      | 模块未启用、未知 `assetId`/`walletId`     | 不可枚举，显示"不存在"            |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`     | 账号尚未 bootstrap                        | 先走 `POST /v2/session/bootstrap` |
| 409  | `VERSION_CONFLICT`               | 活跃钱包、自选 CAS                        | 重新 `GET` 后合并再提交           |
| 422  | `CHAIN_MISMATCH`                 | 非 `eip155:56` 的 `assetId`               | 修请求，不重试                    |
| 422  | `VALIDATION_FAILED`              | 自选包含未登记资产                        | 提示用户该资产不可加入自选        |
| 503  | `CAPABILITY_UNAVAILABLE`         | RPC 未配置/不可达/链不符                  | 整块 unavailable，可重试          |
| 503  | `INDEXING_DELAYED`               | indexer 未运行                            | 活动列表 unavailable，可重试      |
| 503  | `PROVIDER_DISCONNECTED`          | Privy 钱包清单不可达                      | 钱包页 unavailable，可重试        |

## 11. 本步明确 unavailable 的产品项

| 项目                              | reasonCode                             |
| --------------------------------- | -------------------------------------- |
| 估值、净值、美元总额、24h 涨跌    | `MARKET_PRICE_PROVIDER_NOT_CONFIGURED` |
| 原生 BNB 转账历史                 | `NATIVE_TRANSFER_SCAN_NOT_SUPPORTED`   |
| 跨链活动、挖矿领取记录            | `CROSS_CHAIN_ACTIVITY_NOT_SUPPORTED`   |
| 待确认金额（indexer 未跑）        | `BSC_INDEXER_NOT_STARTED`              |
| 代币余额与 Privy 的交叉核对       | `PRIVY_ASSET_MAPPING_UNAVAILABLE`      |
| 外部钱包的 Privy 余额交叉核对     | `PRIVY_WALLET_ID_UNAVAILABLE`          |
| Privy 余额读取失败/超时的交叉核对 | `PRIVY_BALANCE_CROSS_CHECK_FAILED`     |
| Swap 入口                         | `SWAP_MODULE_NOT_DELIVERED`            |
| Pay、Bridge、DApp、smart-money    | 各自 capability 的 `deferred`          |

原型 `wallet` 页的"安全中心 / 授权盘点 / DApp 浏览器"三行副标题（MFA 状态、
授权数量、已启用链数）在本步没有后端，属于 D16/D20，必须显示 unavailable 或
不渲染副标题，不能写死数字。
