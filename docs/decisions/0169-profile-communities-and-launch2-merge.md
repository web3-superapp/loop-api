# 0169 · 他人主页：社区列表开放 + 持仓 / 交易合并 Launch 链（S260-api，2026-10-20）

## 1. Status

已实现（分支 `feat/S260-profile-communities-launch2`，基线 `integration/v2` `0ceab3d`）。只读：无迁移、无新表、无写路径。新路径 1 条，新 env `PROFILE_LAUNCH2_EMIT`（`off|on`，默认 `off`，其他值拒绝启动），隐私默认值 1 处变化。

## 2. Context

- 需求方：他人主页「社区」tab 显示「已加入 N 个社区，社区列表暂未开放查看」→ 放开；「持仓 / 交易」在测试阶段为空（只读主网），要像钱包一样显示 Launch 链（MEME v2）的持仓与买卖。
- 决策 0166 §D：已发布 App 的 V2 解码器严格拒绝未知键，既有响应新增键必须放在默认 `off` 的开关后面；新路径不受限。
- 决策 0167 已有 Launch 链活动读模型（`WalletActivityMergeRepository`）与 14 键行形状，本决策复用。

## 3. Decision

### A. `GET /v2/profiles/{publicProfileId}/communities`（新路径）

- 实体：对方的成员关系（`community_memberships`），只列 `status <> 'banned'`（active / muted，含 owner 角色）且社区 `verification_status = 'verified'` 的行——与 `counts.communities` 同一集合；pending 与 rejected（下架）不列。
- 顺序：`joined_at desc, community_id desc`；游标 continuation `{j: joined_at 微秒, c: communityId, n: 页大小}`，绑定查看者 / 路由 `v2ProfileCommunities` / `profile=<id>`。首页 `limit` 默认 20、最大 50；后续页只带 cursor 时沿用 `n`（移动端 S261 只在首页带 limit）。
- 可见性：本人永远可见；否则 `visibility.communities === "everyone"` 才可见，不可见返回 `{status:"unavailable", reasonCode:"PROFILE_COMMUNITIES_HIDDEN", contractVersion}`。被拉黑 / 不存在 = 既有 `404 PROFILE_NOT_FOUND`。
- `verificationStatus` 枚举 `verified|unverified`（目前恒为 verified，`unverified` 预留）；`logoRef` 只放行 `avatar:preset/community-NN` 与 `logo:media/{uuidv4}`，其他一律 `null`。
- 无数据库 / 未配游标密钥：`503 CAPABILITY_UNAVAILABLE`（fail closed）。

### B. 隐私默认值 `communities: everyone`

- `defaultPrivacyV2Values.visibility.communities` 由 `self` 改为 `everyone`；公开资料读取的缺行默认（`coalesce(..., 'everyone')`）同步。`GET /v2/profile/privacy` 的 version-0 默认随之变化（只是值变化，不新增键）。
- **不动已有显式行**（主代理裁决）。列默认值 `privacy_preferences_v2.communities_visibility default 'self'` 未改：所有写入都显式带全部字段，列默认从不生效，为避免与并行分支争迁移号，本批不加迁移（如需对齐可后续追加一条只改列默认的迁移）。
- 现状核查：本机 dev 库（staging 由 dev 导入）`privacy_preferences_v2` 0 行，即当前所有账号都走缺行默认，改动后立即全部可见。
- 隐私值域只有 `self|everyone`（库 check 约束），没有任务单里写的 `friends` 档；好友关系不影响结果。

### C. `PROFILE_LAUNCH2_EMIT`（默认 `off`）：holdings / trades 合并 Launch 链

- `off`（或未设置）：两个路由与 `0ceab3d` 逐字节一致（快照取自 `0ceab3d`，覆盖 available / 分页两页 / hidden / 未绑钱包 / 转账车道未起），且不读任何 launch2 数据、不读 Launch 链 head。
- `on`：组合 `launch2: { chainId: LAUNCH_CHAIN_ID 对应 CAIP-2, activity: Database.walletActivityMerge, holdings: launch2Service.listAddressHoldings, readHead: Launch 链读客户端 }`。钱包地址只作事实匹配，不出现在响应里。

**holdings**：主网行照旧在前；之后追加对方活跃钱包的 launch2 行（来源 `launch2_positions`，含隐藏 listing 的实例，同 0167）：

- `launch2_meme`：毕业后 = 链上实时 MEME 余额（launch2 服务的 15 s 缓存读），毕业前 = 曲线 bought − sold；只在 > 0 时出行；毕业后余额读失败**不出行**（不猜 0；移动端要求 MEME 行 `amountMeme` 非空）。`valueUsd1` = 数量 × 已索引最新价（毕业后池价，否则曲线价），无价 `null`。
- `launch2_nft`：`nftHeld >= 1` 时出行，`nftCount` 为整数。
- `status / reasonCode / totalUsd / observedAt` 只描述主网；`totalUsd` 不含 launch2。主网不可读时仍返回 launch2 行。
- 隐藏（`totalAssets` 非 everyone 且非本人）/ 未绑钱包：与 off 完全相同，无 `launch2` 键、不读 launch2。

**trades**：主网行（`listTradesByTime`：同 `listTrades` 规则，时间 = 区块时间，否则观测时间）与 0167 `listLaunch2Activity` 七种 kind 合并；全序与游标同 0167：`(时间 µs, blockNumber, logIndex, source erc20|launch2, hash)` 降序，continuation `{at, block, log, src, tx}`，filter `profile=<id>;launch2=<chainId>`——与 off 游标互不通用（任一方向 400）。每腿各取 n+1，合并取 n，翻页防御检查同 0167。`tradeHistory` 隐私照旧。主网转账车道未起时 `status: unavailable, BSC_INDEXER_NOT_STARTED`，但 launch2 行照常返回。

**`launch2` 块**（两形状同 0167）：`{status:"available", chainId, indexerBlockNumber, headBlockNumber|null}` / `{status:"unavailable", reasonCode}`，reasonCode ∈ `LAUNCH2_INDEXER_NOT_STARTED`、`LAUNCH2_REPOSITORY_UNAVAILABLE`、`LAUNCH2_HOLDINGS_READ_FAILED`（holdings）、`LAUNCH2_ACTIVITY_READ_FAILED`（trades）。launch2 腿失败不使整页失败（记 warn 日志）。

### D. 给 loop-mobile 的键清单

| 接口           | 位置                          | 键                                                                                                                                                                                                                                                       |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| communities    | 根（available）               | `status`、`items`、`nextCursor`、`contractVersion`                                                                                                                                                                                                       |
| communities    | 根（unavailable）             | `status`、`reasonCode`（`PROFILE_COMMUNITIES_HIDDEN`）、`contractVersion`                                                                                                                                                                                |
| communities    | items[]                       | `communityId`、`name`、`slug`、`logoRef`(string\|null)、`memberCount`(int)、`verificationStatus`(`verified`\|`unverified`)、`joinedAt`(ISO)                                                                                                              |
| holdings（on） | 根可选                        | `launch2`                                                                                                                                                                                                                                                |
| holdings（on） | 有 `kind` 的行（10 键全必带） | `kind`(`launch2_meme`\|`launch2_nft`)、`chainId`、`instanceId`、`ticker`、`name`、`logoUrl`、`amountMeme`(meme 行非空字符串 / nft 行 null)、`nftCount`(nft 行 int≥1 / meme 行 null)、`stage`(launch2 stage 枚举)、`valueUsd1`(string\|null；nft 行 null) |
| trades（on）   | 根可选                        | `launch2`                                                                                                                                                                                                                                                |
| trades（on）   | 无 `eventId` 的行（14 键）    | `kind`、`chainId`、`instanceId`、`ticker`、`name`、`logoUrl`、`amountMeme`、`amountUsd1`、`taxUsd1`、`transactionHash`、`logIndex`、`blockNumber`、`occurredAt`、`confirmations`                                                                         |

主网 trades 行本来就带 `kind`（buy/sell/transfer_*），客户端用 **`eventId` 是否存在** 区分：有 = 主网 9 键行，无 = launch2 14 键行。

### E. 开启顺序

1. communities 新路径与隐私默认值随本分支上线即生效（不受开关限制）。
2. loop-mobile S261（commit `69dce56b`）的 codec 随 **build 34** 发布 → 所有仍受支持的版本 ≥ 34 → 在目标环境把 `PROFILE_LAUNCH2_EMIT` 切到 `on`。在此之前 staging / 生产保持 `off`。staging env 行：`PROFILE_LAUNCH2_EMIT=off`（build 34 后改 `on`）。

## 4. Consequences

- 开关切换使客户端手里的 trades 旧游标失效一次（400 → 重拉第一页）。
- 通过普通 ERC-20 转账（非曲线 / 池交易 / NFT）收到 MEME 的钱包不在 `launch2_positions`，其持仓不出现（与 `me/positions` 同口径）。
- 测试：`test/v2-public-profile-launch2-routes.test.ts`（off/unset 逐字节快照、on holdings / trades 形状与键序、各 unavailable、逐页无重无漏、游标跨模式 400、communities 可见性 × 好友关系、分页 / 游标沿用页大小 / logoRef 过滤 / 404 / 400 / 503）；`test/profile-communities-launch2.integration.test.ts`（真实 PostgreSQL：成员关系顺序与键集分页、banned / pending / rejected 排除、缺行默认 everyone 与显式 self × 好友 / 非好友；晚风式两实例持仓 + NFT 1 枚 + 曲线 / 池买卖 + 铸造 + 主网 swap / 转账经服务合并，页大小 1/2/3/7/50 同序）；`test/config.test.ts`；既有 `v2-profile-routes` / `profile-v2-repository` 默认值断言同步。
