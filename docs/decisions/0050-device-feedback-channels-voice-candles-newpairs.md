# 0050 · 真机反馈四条：官方群供给、语音房开房脚本、BNB K 线代理、新币发现开关（S30）

- 日期：2026-09-17
- 来源：用户 2026-09-17 真机原话「社区官方群为什么很多都没有」「语音房怎么试」「行情中的新币发现为什么不可用」「BNB 的 K 线也不可用」；主代理任务单 S30-backend
- 范围：`scripts/community-provision-channels.ts`、`scripts/voice-room-open.ts`、`GET /v2/market/assets/{assetId}/candles`、Development 栈的 `MARKET_PROVIDER_GECKOTERMINAL_ENABLED`。不加表、不改 migration、不改 `/v1`、不改 Stream 角色权限。
- 基线：`integration/v2` = `fc9370d`

## 1. 官方群：seed 出来的 verified 社区没有频道

### 事实

`community_channels` 只在 `verifyCommunity` 里分配（决策 0032）。42 个 `mock-*` 社区是 seed 直接写库成 `verified` 的，从没经过这条路，于是 `community_channels` 0 行、`chat` 块永远 `COMMUNITY_CHANNEL_NOT_PROVISIONED`。`builders-guild` 有频道，只因为它走过 `pnpm community:verify`。

### 裁决

| 项目             | 裁决                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修复路径         | 复用产品自己的路径：对已 `verified` 的社区再调一次 `repository.verifyCommunity`，它走 `repair` 分支——分配频道行、给每个未 `synced` 的非 banned 成员入队一条 `add` job、**不写第二条 `community_verified` 审计行**。不直写 `community_channels`。           |
| 入口             | `pnpm community:provision-channels --confirm`。候选 = `verified` 且无 `community_channels` 行（`listVerifiedCommunitiesWithoutChannel`，只读）。已有频道的社区不是候选，重复执行是 no-op。`NODE_ENV=production` 在连库前拒绝。                             |
| Stream 写入      | 仍然全部由 `community-channel-sync` worker lane 执行：先 `upsertCommunityChannel` 建频道，再逐成员 `upsertUsers` + `addMembers`。脚本本身不碰 Stream。                                                                                                     |
| 成员同步规则     | **照 verify 的规则：全量成员都入队**（不是按需）。311 人的 `mock-defi-morning` 会产生 311 条 job；lane 每批 20 条、每条两次 Stream 调用，Development 上约 1 job/s。成员 cap `V2_COMMUNITY_CHANNEL_MEMBER_CAP`（默认 3000）之外的成员标 `capacityPending`。 |
| 用户进群时的表现 | 频道行已建、本人 job 未跑完：`chat.status = "syncing"`（`COMMUNITY_CHANNEL_MEMBER_SYNCING`）；跑完变 `available`。频道行未建（worker 尚未 provision）：`syncing` + `COMMUNITY_CHANNEL_NOT_PROVISIONED`。                                                   |
| reason code      | 审计/job 的 `reasonCode` 固定 `operator_channel_provision`，与 `community:verify` 的 `operator_manual_review` 区分。                                                                                                                                       |

## 2. 语音房：产品里谁能开房

### 事实

- 开房路由是 `POST /v2/communities/{communityId}/voice-rooms`，owner 或 admin；Stream `audio_room` call 由后端用 server key 创建（`createAudioRoom`，host 带 `admin` 角色或 `user` + 显式权限回退），**不依赖 `user` 角色的 create-call**，所以 S15 的角色证据（`user` 无 create-call）与开房不冲突。
- 走查账号 `cy` 是 `mock-defi-morning` 的 owner、`mock-meme-room` 等 3 个社区的 admin、`builders-guild` 的普通 member。
- **App 内没有开房入口**：`loop_v2_communication_api.dart` 只封装了 `current`、`GET /v2/voice-rooms/{id}`、hand-raises 与房内命令，没有 create。`voice_room_screens.dart` 没有"开房"按钮。所以 `voice_rooms` 0 行、页面永远"当前没有进行中的语音房"。

### 裁决

| 项目       | 裁决                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入口       | dev-only `pnpm voice-room:open <communityId> --confirm`。host = 该社区 owner（从 `community_memberships` 读，必须有 active profile）。走现有 `createVoiceRoomService().createRoom`：先提交 `voice_rooms` + host 成员 + 审计，再用 `createStreamCallGateway(config.stream)` 创建一次 call，结果写回 `provisionState`。 |
| 幂等/冲突  | 与路由同一段代码：社区已有 `live` 房 → `RESOURCE_CONFLICT`，脚本报告并退出 1。Stream 未确认 → 房间 `reconciling`、`providerSync.unconfirmed`，脚本如实打印。                                                                                                                                                          |
| 不做的事   | 不改 Stream 角色权限；不给 App 加开房按钮（前端跟进项）；不改 `voice_rooms` 表。                                                                                                                                                                                                                                      |
| 用户怎么试 | 见 `docs/frontend-v2-communication-api.md` §5「Development 上怎么试」。                                                                                                                                                                                                                                               |

## 3. BNB K 线：`eip155:56:native` 走 WBNB 代理

### 事实

原生 BNB 没有合约地址，没有登记的池，`getCandles` 对 `address === null` 直接 `MARKET_NATIVE_ASSET_NOT_SUPPORTED`。价格事实（决策 0034）、钱包估值（`valuation.quality: proxied`）、挖矿参考价（决策 0044）都已经用 WBNB 1:1 代理，只剩 K 线没接。

### 裁决

| 项目     | 裁决                                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代理     | `getCandles` 对 native 资产从 registry 读 `eip155:56:0xbb4c…`（WBNB）；WBNB 未登记/blocked/无地址 → 仍 `MARKET_NATIVE_ASSET_NOT_SUPPORTED`。用 WBNB 的池、地址、decimals 取 K 线，Provider 路径与 indexer 派生路径都一样。                      |
| 标记     | `candles.quality = "proxied"`（枚举新增），新增必填键 `candles.proxyAsset`（代理资产 ID，非代理时 `null`）。`source`（`geckoterminal` / `loop_indexer`）与 `labelKey`（派生时仍是 `market.candles.onChainSwapAggregate`）照旧说明数据怎么来的。 |
| 单位     | `priceUnit` 写**实际被定价的资产**：`USD per WBNB` / `USDT per WBNB`。响应顶层 `assetId` 仍是 `eip155:56:native`。前端标注"以 WBNB 计价"，与钱包页一致。                                                                                        |
| 不代理的 | 安全事实、持有人、成交（trades）对 native 仍 `MARKET_NATIVE_ASSET_NOT_SUPPORTED`：GoPlus 没有 native 一说，trades 的 `isOwn` 按调用者地址判断，代理会把 WBNB 的成交说成 BNB 的成交。                                                            |
| 其它资产 | 只有 native 走代理；任何其它资产永远不被替换。                                                                                                                                                                                                  |

## 4. 新币发现：Development 打开 GeckoTerminal

### 事实

- `GET /v2/market/new-pairs` 与 `overview.newPairs` 只依赖 `MARKET_PROVIDER_GECKOTERMINAL_ENABLED`；`ops/api-dev.env:30` 为 `false`（go-no-go #12 商业条款待确认）。
- 免费公共 API 不需要 key，文档限速 30 次/分钟；实测 `GET /networks/bsc/new_pools?page=1` 无 header 直接 200。适配器把节流硬上限钉在 30。worker 进程不构造 candles Provider（`candlesProvider: null`），所以只有 API 进程在用配额。
- 商业条款（provider-lock `geckoterminal_service` 仍 `PENDING`）**没有变化**；用户裁决 Development 环境"都要做"。

### 裁决

| 项目     | 裁决                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 开关位置 | `ops/api-dev.local.env`（本机开关层、不入库）加 `MARKET_PROVIDER_GECKOTERMINAL_ENABLED=true`、`MARKET_GECKOTERMINAL_RATE_LIMIT_PER_MINUTE=30`。`api-dev.env`、`.env.example`、仓库默认保持 `false`。                                 |
| 生产     | 仍关闭，直到 provider-lock 的条款/配额/署名证据补齐。                                                                                                                                                                                |
| 能力清单 | `GET /v2/meta/capabilities` 没有对应 GeckoTerminal 的 capability（Provider 可用性不在 capability 里，见 `docs/frontend-v2-market-api.md`），所以 `23/31` **不会因此变化**；可用性看 `overview.newPairs.status` 与 `new-pairs` 本身。 |
| 副作用   | 开关一开，所有已登记池的 K 线优先走 GeckoTerminal OHLCV（USD 计价、`quality: fresh                                                                                                                                                   | stale`），indexer 派生成为回退。 |

### 开关打开后发现的一条

第一次 `GET /v2/market/new-pairs` 返回 `MARKET_PROVIDER_RESPONSE_MALFORMED`：实测那一页 20 个池里有 6 个 `uniswap-v4-bsc` 池，GeckoTerminal 用 **32 字节 pool id**（`0x` + 64 hex）而不是合约地址标识它们，适配器把"不是 EVM 地址"一律判成 malformed，整页作废。

| 项目 | 裁决                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 归类 | pool id 是 Provider 的真实事实，不是坏响应；其它任何既不是地址也不是 pool id 的值仍是 malformed。                                                                                          |
| 契约 | `poolAddress` 继续只发布地址；pool id 行**不列出但计数**：`NewPoolsSnapshot.omittedPoolCount` → `newPairs.omittedCount`（必填整数，OpenAPI 已更新）。不把 pool id 伪装成地址，也不静默丢。 |
| 不做 | 不扩 `poolAddress` 的模式去装 pool id（客户端按地址解析），不为 V4 池另开字段——等有页面要展示 V4 池再议。                                                                                  |

## 涉及文件

- `scripts/community-provision-channels.ts`、`test/community-provision-channels.test.ts`、`src/database/community-repository.ts`（`listVerifiedCommunitiesWithoutChannel`）、`test/community-repository.integration.test.ts`
- `scripts/voice-room-open.ts`、`test/voice-room-open.test.ts`
- `src/features/market/market-read-service.ts`、`src/routes/v2/market-schemas.ts`、`openapi/loop-api.v2.json`、`test/v2-market-routes.test.ts`
- `docs/api-inventory.md`、`docs/frontend-v2-community-api.md`、`docs/frontend-v2-communication-api.md`、`docs/frontend-v2-market-api.md`
