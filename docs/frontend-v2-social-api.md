# 前端联调：公开资料页与删除好友（S107，决策 0095）

`user-profile` 页（`/profile/user?id=`、`/u/{loopId}` 深链）的后端契约。机器契约
以 `openapi/loop-api.v2.json` 为准；错误体七字段与通用 header 规则见
`docs/api-v2-conventions.md`、`docs/frontend-v2-community-api.md` §1。

## Base URL、启用条件与 headers

- Development：`https://api-dev.quant-dinger.cc`；本机 `http://127.0.0.1:3000`。
- 随 `community` 模块注册（`V2_MODULES_ENABLED` 含 `community`）；未启用 → 全部
  `404 NOT_FOUND`。
- 读接口：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

读接口带 `Idempotency-Key` → `400 INVALID_REQUEST`。

- 写接口（`DELETE /v2/friends/...`）额外必需
  `Idempotency-Key: <canonical lowercase UUIDv4>`。
- 所有响应 `Cache-Control: no-store`。

## 共同规则

- 目标必须是已激活资料。**不存在 / 未激活 / 对方拉黑了你** 一律
  `404 PROFILE_NOT_FOUND`（`userMessageKey: errors.profile.notFound`），不泄露
  是否被拉黑。文案统一「用户不存在或不可见」。
- 不看 `discoverable`（它只管别名搜索与推荐是否列出该用户）；从聊天头像、分享链接都能进。
- 决策 0096（S107b）起，加好友（`POST /v1/friend-requests` 与 `POST /v2/message-requests`）和关注
  （`POST /v2/connections/follow/{id}`）都**不看**对方的 `discoverable`：只要对方已激活、未关闭
  `friendRequests`（关注不看此项）、双方无拉黑即可；否则仍是同一个非枚举 404。
- 看自己也返回 200（`relationship` 全 false / `none`）；客户端按需求直接跳 Me。
- 钱包地址永不下发。

## 从 Stream 头像进入资料页

社区群、小群、私聊、语音房里的头像只拿得到 Stream user。服务端写入的每个 Stream user
都带自定义字段 **`publicProfileId`**（= `GET /v2/profiles/{publicProfileId}` 用的公开
标识；不是 LOOP user id，也不是钱包地址）：

```json
{
  "id": "loop_6d12a86e413447e69312c5ef75a30f55",
  "name": "frog_maxi",
  "image": "https://api-dev.quant-dinger.cc/v2/media/22222222-2222-4222-8222-222222222222.webp",
  "publicProfileId": "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
}
```

- Flutter `stream_chat`：`user.extraData['publicProfileId'] as String?`；Stream Video：
  `user.custom['publicProfileId']`。服务端通过 `custom` 写入，Chat 端展开到 user 顶层。
- 字段缺失（对方资料未激活、或服务端尚未回填）→ 头像不可点，不要从 Stream user id
  反推任何 LOOP 标识。
- 拿到后直接 `GET /v2/profiles/{publicProfileId}`；对方拉黑了你仍是
  `404 PROFILE_NOT_FOUND`，按「用户不存在或不可见」处理。
- 等于自己（与本人资料的 `publicProfileId` 相同）时直接跳 Me。
- `connectUser` 只传 `id`，不要传 `name` / `image` / 自定义字段，否则会覆盖服务端写的值。

## `GET /v2/profiles/{publicProfileId}`、`GET /v2/profiles/by-loop-id/{loopId}`

`loopId` 大小写不敏感（`loop-7hjkmnpq` 可用）；格式对但不在 LOOP 字母表里的 ID →
`404 PROFILE_NOT_FOUND`；格式错 → `400 INVALID_REQUEST`。

```json
{
  "publicProfileId": "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
  "loopId": "LOOP-7HJKMNPQ",
  "alias": "frog_maxi",
  "avatarRef": "avatar:media/22222222-2222-4222-8222-222222222222",
  "bio": "gm",
  "joinedAt": "2026-09-07T01:00:00.000Z",
  "counts": { "followers": 3, "following": 2, "communities": 1 },
  "relationship": {
    "following": true,
    "followedBy": false,
    "friendship": "pending_out",
    "blocked": false,
    "blockedBy": false
  },
  "visibility": { "holdings": true, "trades": true },
  "contractVersion": "2.0"
}
```

- `friendship`：`none` | `pending_out`（我发出的未过期请求）| `pending_in`（对方发给我）| `friends`。
- `blocked`：我拉黑了对方（仍可看资料，动作行显示「解除拉黑」）。`blockedBy` 在 200
  中恒为 `false`（被拉黑是 404）。
- `counts.communities`：对方在已认证社区里的非封禁成员身份数。
- `visibility.holdings/trades`：对方是否公开（对应其隐私 `totalAssets` /
  `tradeHistory` 是否 `everyone`）。
- 动作对应接口：加好友 `POST /v2/message-requests`；私聊
  `POST /v2/chat/direct-channels`；关注 `POST|DELETE /v2/connections/follow/{id}`；
  拉黑 `POST /v2/blocks`；举报并屏蔽走 message-request 的 `report` 决策；删除好友见下。

## `GET /v2/profiles/{publicProfileId}/holdings`

```json
{
  "status": "available",
  "reasonCode": null,
  "totalUsd": "312.25",
  "items": [
    {
      "assetId": "eip155:56:0x55d398326f99059ff775485246999027b3197955",
      "symbol": "USDT",
      "name": "Tether USD",
      "logoUrl": "https://api-dev.quant-dinger.cc/v2/market/logos/eip155:56/0x55d398326f99059ff775485246999027b3197955.png",
      "balance": "12",
      "usdValue": "12"
    }
  ],
  "observedAt": "2026-10-08T00:00:01.000Z",
  "contractVersion": "2.0"
}
```

- 数据源：对方当前选中的活跃钱包，链上一次读取（与 `GET /v2/wallets/{id}/balances`
  同一服务、同一资产注册表）。余额为 0 或读不到的行不列出。
- `balance`、`usdValue`、`totalUsd` 都是十进制字符串；`usdValue` 无价格时 `null`；
  `totalUsd` 只有在列出的每行都有价格时才给，否则 `null`（显示「—」）。
- 三态：

| status        | reasonCode                   | 客户端                            |
| ------------- | ---------------------------- | --------------------------------- |
| `available`   | `null`                       | 列表（`items` 可为空 = 没有持仓） |
| `hidden`      | `null`                       | 「对方未公开」                    |
| `unavailable` | `WALLET_NOT_BOUND`           | 「对方暂无钱包」                  |
| `unavailable` | `BSC_READ_UNAVAILABLE`       | 「链上数据暂不可用」，可重试      |
| `unavailable` | `WALLET_RUNTIME_UNAVAILABLE` | 同上（服务端未组合钱包运行时）    |

`unavailable` 时 `items` 为空、`totalUsd`/`observedAt` 为 `null`，**不要显示 0**。

## `GET /v2/profiles/{publicProfileId}/trades?cursor&limit`

`limit` 1–50，默认 20；`cursor` 用上一页的 `nextCursor` 原样传（与查看者、目标
绑定，跨账号/跨目标/篡改 → `400 INVALID_REQUEST`）。

```json
{
  "status": "available",
  "reasonCode": null,
  "items": [
    {
      "eventId": "9c1f0e2a-7b3d-5e4f-a1b2-c3d4e5f60718",
      "kind": "buy",
      "assetId": "eip155:56:0x1111111111111111111111111111111111111111",
      "symbol": "FROG",
      "amount": "2.5",
      "usdValue": "10",
      "blockTimestamp": "2026-10-01T00:00:00.000Z",
      "blockNumber": "300",
      "txHash": "0xaaaa…"
    }
  ],
  "nextCursor": "…",
  "contractVersion": "2.0"
}
```

- 新到旧，按区块与日志序。`kind`：
  - `buy` / `sell`：已登记 PancakeSwap V3 池里、`recipient` 或 `sender` 是该钱包的
    Swap。资产 = 池子里不是计价币（WBNB/USDT/USDC/USD1）的那个币；池子付出该币 =
    `buy`，收进 = `sell`。`usdValue` = 计价币为美元稳定币时的成交额，否则 `null`。
  - `transfer_in` / `transfer_out`：注册表资产的转账（不含已作为 Swap 列出的同一笔
    交易的转账腿，不含自转）。稳定币转账 `usdValue = amount`，其他 `null`。
  - 经路由合约托管（多跳、换成原生 BNB）的 Swap，链上 recipient 是路由而不是钱包，
    这类只会以转账形式出现。
- `blockTimestamp` 可能为 `null`（转账所在区块没有已索引的池事件）；此时用
  `blockNumber` 排序展示即可。
- `eventId` 不透明、稳定，可作列表 key。
- 三态同上：`hidden`（对方关闭了交易公开）；`unavailable` 的 `reasonCode` ∈
  `WALLET_NOT_BOUND`、`BSC_INDEXER_NOT_STARTED`、`V2_CURSOR_NOT_CONFIGURED`。

## `DELETE /v2/friends/{publicProfileId}`

写 header（含 `Idempotency-Key`），无 body/query。

```json
{
  "publicProfileId": "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
  "friendship": "none",
  "removed": true,
  "contractVersion": "2.0"
}
```

- 解除双向好友关系；本来不是好友也成功（`removed: false`）。
- 同 key 重放返回第一次结果；同 key 换目标 → `409 IDEMPOTENCY_CONFLICT`。
- 目标不存在 / 未激活 / 是自己 → `404 NOT_FOUND`。拉黑不影响删除。
- 不动关注关系、不删历史请求；之后可重新发好友请求。已存在的 Stream 私聊频道不会被
  删除，但重新打开私聊受「仅好友」开关约束。

## 错误码汇总

| HTTP | code                                                                   | 接口                                   |
| ---- | ---------------------------------------------------------------------- | -------------------------------------- |
| 400  | `INVALID_REQUEST`                                                      | 全部（header、ID 格式、cursor、limit） |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID`                                       | 全部                                   |
| 404  | `PROFILE_NOT_FOUND`                                                    | 四个资料读接口                         |
| 404  | `NOT_FOUND`                                                            | 删除好友                               |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`                                           | 全部                                   |
| 409  | `IDEMPOTENCY_CONFLICT`                                                 | 删除好友                               |
| 503  | `CAPABILITY_UNAVAILABLE` / `PROVIDER_DISCONNECTED` / `REQUEST_TIMEOUT` | 全部（数据库不可用等）                 |

## 验收状态

- 已通过：路由/契约单测、PostgreSQL 集成测试（关系推导、删除好友幂等与审计、
  交易分页与分类、推荐社区）。
- 未验证：真机链上持仓（RPC 额度）与真实 Swap 分类，记 unverified。
