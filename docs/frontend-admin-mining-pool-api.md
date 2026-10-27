# loop-admin 对接：挖矿「矿池」表（S313 / 决策 0187）

## 1. 基址、请求头、权限

- Base URL：与其他后台接口相同，`{ADMIN_API_BASE}/admin/v1`（staging：`https://admin-staging.quant-dinger.cc` 反代到 API）。
- 鉴权：后台会话 cookie（`POST /admin/v1/session`）。读接口无需其它头；保存走既有 `POST /admin/v1/mining/parameter-versions`（与「挖矿参数」页相同：仅会话 cookie，无 Idempotency-Key）。
- 权限：列表 `console.read`（platform_admin、auditor）或 `formula.approve`（reviewer）；保存草稿 `console.write`（platform_admin）；批准 `formula.approve`（reviewer，且不是草稿作者）。
- 响应头 `Cache-Control: no-store`。

## 2. 规则（矿池表每一格的含义）

- 行 = 已验证社区 × 它绑定的 LOOP 发射 MEME（任何链），自动入列，不需要登记。
- 币权重：参数文档 `assetWeights` 里有就用；没有就是 **1**；资产在 `excludedAssets` 里 → 0。
- NFT 系数：`communityCoefficients` 里有就用；没有就是 `defaultCommunityCoefficient`（1）；社区在 `excludedCommunities` 里 → 0。
- 参与：资产与社区都不在 excluded 里。取消勾选 = 两个都加入 excluded。
- 结算与 App 快照用同一套规则：只算该社区成员（含创建者）的持仓；快照算力 = MEME 余额 × 币权重 + NFT 数 × NFT 系数。

## 3. `GET /admin/v1/mining/pool`

| query     | 说明                                                                |
| --------- | ------------------------------------------------------------------- |
| `address` | 可选，MEME 合约地址 `0x` + 40 hex，精确匹配，大小写不敏感（搜索框） |
| `q`       | 可选，≤ 64 字，社区名或 ticker 子串，大小写不敏感                   |
| `limit`   | 可选，1–100，默认 20；不可与 `cursor` 同时给                        |
| `cursor`  | 可选，上一页的 `nextCursor`（绑定 `address` / `q`，换条件后作废）   |

排序：社区名，再按 communityId。

```json
{
  "inForce": {
    "versionId": "11111111-1111-4111-8111-111111111111",
    "configVersion": "s313-pool-2026102710",
    "effectiveFrom": "2026-10-27T02:00:00.000Z"
  },
  "pendingDraftVersion": null,
  "items": [
    {
      "communityId": "c0000000-0000-4000-8000-000000000001",
      "communityName": "Alpha Frogs",
      "assetId": "eip155:97:0xaaaa111111111111111111111111111111116666",
      "chainId": "eip155:97",
      "memeAddress": "0xaaaa111111111111111111111111111111116666",
      "symbol": "ALPHA",
      "instanceId": "d0000000-0000-4000-8000-000000000001",
      "launchId": "0x0000000000000000000000000000000000000000000000000000000000000001",
      "participate": true,
      "tokenWeight": "1",
      "nftCoefficient": "1",
      "source": "default",
      "pendingDraft": null
    }
  ],
  "nextCursor": null
}
```

- `inForce`：当前生效的参数版本；`null` = 还没有批准过任何版本，每行显示默认值（参与 / 1 / 1）。
- `source`：`explicit` = 文档在 `assetWeights` / `communityCoefficients` / `excludedAssets` / `excludedCommunities` 任一处点名了这行的资产或社区；`default` = 全部默认。
- `pendingDraft`：有待批草稿时，这一行在草稿里的值（`{versionId, configVersion, participate, tokenWeight, nftCoefficient, source}`），可用来高亮「待审核」差异；没有草稿为 `null`。`pendingDraftVersion` 是同一草稿的引用。
- `instanceId`：launch2 实例 opaque ID（可链接到后台 MEME v2 实例页）；`launchId` 是链上 launch id，仅展示。
- 数值都是十进制字符串（最多 18 位小数）。

## 4. 保存：折算成一个参数草稿

`POST /admin/v1/mining/parameter-versions`（已有接口）：

```json
{
  "configVersion": "s313-pool-2026102712",
  "effectiveFrom": "2026-10-27T05:00:00.000Z",
  "parameters": {
    "referralRatiosBps": [1000, 500, 300, 200, 100],
    "dailyBudgetNftRaw": "500000000000000000000000",
    "dailyBudgetAssetRaw": "500000000000000000000000",
    "releaseStartAt": "2026-10-10T00:00:00.000Z",
    "releaseDays": 900,
    "minimumClaimRaw": "1000000000000000000",
    "defaultCommunityCoefficient": "1",
    "assetWeights": [
      {
        "assetId": "eip155:97:0xbbbb111111111111111111111111111111116666",
        "weight": "2"
      }
    ],
    "communityCoefficients": [],
    "excludedAssets": ["eip155:97:0xcccc111111111111111111111111111111116666"],
    "excludedCommunities": ["c0000000-0000-4000-8000-000000000003"]
  }
}
```

折算规则：

1. 以 `inForce` 版本的 `document`（`GET /admin/v1/mining/parameter-versions` 里拿）为底，其它键原样带上。
2. 每个矿池行：
   - 取消勾选：`assetId` 进 `excludedAssets`，`communityId` 进 `excludedCommunities`；同时从 `assetWeights` / `communityCoefficients` 去掉这两项。
   - 勾选：两项都不出现在 excluded；币权重 ≠ 1 时写入 `assetWeights`；NFT 系数 ≠ `defaultCommunityCoefficient` 时写入 `communityCoefficients`（等于默认值可省略）。
3. 不在矿池表里的显式行（例如其它资产权重）原样保留。
4. `communityCoefficients` 必须显式给出（哪怕 `[]`）：省略时后端会按旧规则「冻结复制快照权重」。
5. 生效时间须在未来；草稿由另一名审核员在「挖矿参数」待批列表批准后生效（下一个整点结算起）。

保存 / 批准的错误：

| HTTP | code                       | `detailsSafe`                                                                                     |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| 422  | `MINING_COMMUNITY_UNKNOWN` | `reasonCode`, `field` = `communityCoefficients` \| `excludedCommunities`, `unknownCommunityIds[]` |
| 422  | `VALIDATION_FAILED`        | `reasonCode: ADMIN_MINING_PARAMETERS_INVALID`, `field`（如 `excludedAssets`）                     |
| 422  | `VALIDATION_FAILED`        | `reasonCode: MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`, `assetId`                                   |
| 422  | `VALIDATION_FAILED`        | `reasonCode: ADMIN_MINING_PARAMETERS_EFFECTIVE_PASSED`                                            |
| 409  | `ADMIN_CONFLICT`           | `reasonCode: ADMIN_MINING_PARAMETERS_VERSION_EXISTS` 等（同挖矿参数页）                           |

`excludedAssets` 最多 500 条、`excludedCommunities` 最多 2000 条，均不可重复。

## 5. 列表错误

| HTTP | code                     | 场景                                                                                       |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------ |
| 400  | `INVALID_REQUEST`        | `address` 格式错、`q` 过长、`limit` 越界、`cursor` 与 `limit` 同给、游标无效或换了过滤条件 |
| 401  | `ADMIN_SESSION_REQUIRED` | 未登录                                                                                     |
| 403  | `PERMISSION_DENIED`      | 角色没有 `console.read` / `formula.approve`（testnet_acceptor）                            |
| 503  | `CAPABILITY_UNAVAILABLE` | 结算存储未配置或数据库不可用                                                               |

## 6. 「快照系数」页

`/admin/v1/mining/formula-versions` 已在 OpenAPI 标 `deprecated`，请隐藏入口（接口保留）。平台 MEME 的结算与 App 显示都只看本表。
