# 0143 · 广场「动态」时间线：帖子、点赞、系统事件、置顶（S187-api-b，2026-10-15）

依据：主代理 S187-api-b 任务单（2026-10-15）；`docs/35-代币列表与代币页设计稿-2026-10-15.md` 与 `body2.html` 的「动态」手机框（每条 = 头像 + 名字 + 类型徽标 + 时间 + 一行代币报价 + 正文 + 点赞数；全球 / 已关注；置顶日报）；Decision 0097（群友买入 lane）、0131（LoopDynamic `RewardClaimed`）、0139（overview 事件来源）、0140（后台增 / 改 / publish / archive、审计、幂等、409 写法，本批照抄）。
范围：只在 `loop-api`。新增 migration `000084_square_feed`、五个 App 接口、六个后台接口、一个 worker lane、能力位 `squareFeed`。不读链、不签名、不改 `/v1`、不改 `ops/*.env`。迁移号 000084 固定（000083 属 S187-api-a，两批不互改表）。

## 1. 实体

`square_posts`（主键 `post_id`，UUIDv4，opaque）：

| 字段（API）        | 列                                                | 规则                                                                                                                         |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `kind`             | `kind`                                            | `opinion`（用户帖）/ `buy` / `claim` / `graduation`（系统事件）/ `system`（后台官方帖）                                      |
| `author`           | `author_user_id` → `loop_users`                   | `system` 为 null，其余必填（库约束）；对外投影为 `identityProjection`（`publicProfileId, loopId, alias, avatarRef`）         |
| `text`             | `text`                                            | trim 后 1..500 code point；opinion / system 必填，事件帖为 null（库约束）                                                    |
| `tokenRef`         | `token_kind` + `token_id`                         | `{kind: meme, id: memeTokenId}` 或 `{kind: launch2, id: instanceId}`，可空；**无外键**，写入时校验存在，读时 left join       |
| `event`            | `event_payload` jsonb                             | 事件帖的事实（金额等，十进制字符串），文案由 App 按 kind 渲染；仅事件帖非空                                                  |
| —                  | `source_event_id`                                 | 事件帖去重键（部分唯一索引），仅事件帖非空                                                                                   |
| `pinned`           | `pinned`                                          | 只有 `system` 可置顶（库约束）                                                                                               |
| `status`           | `status` + `archived_by`                          | `draft` / `published` / `archived`；只有 `system` 有 draft（用户帖、事件帖直接 published）；`archived_by` = author / console |
| `createdAt`（App） | `published_at`                                    | 时间线键：opinion = 发布时刻，system = publish 时刻，事件帖 = 事件时间（区块时间 / claimed_at / graduated_at）               |
| —                  | `created_by`, `created_by_actor`                  | 仅 `system`：后台账号 id（引导管理员 null）与用户名                                                                          |
| —                  | `create_idempotency_key`, `create_request_sha256` | opinion 必有（App 必带键），system 可选；唯一：opinion 按 (作者, 键)，system 按键                                            |

`square_post_likes`：主键 `(post_id, user_id)`，`post_id` 外键 `on delete cascade`，`user_id` → `loop_users`。

索引：时间线 `(published_at desc, post_id desc) where published and not pinned`；作者时间线（following）同序加 `author_user_id` 前缀；置顶 `where published and pinned`；频率限制 `(author_user_id, created_at desc) where opinion`；后台列表 `(created_at desc, post_id)`；点赞 `(user_id, created_at desc)`。

与 0140 不同，这里**有**指向 `loop_users` 的外键（作者 / 点赞人是 LOOP 用户）：12 个集成测试的 `truncate` 列表已加上两张表；`dev:reset-users` 先删被重置用户的点赞与其帖子上的点赞，再删其帖子（`system` 帖无作者，保留）；两表归类 `user`。

## 2. App 接口（Bearer + `X-Loop-*`，`no-store`）

非 `V2_MODULES_ENABLED` 模块，**始终注册**（同 0128 faucet）；能力位 `squareFeed`：数据库仓库与游标密钥都在时 `available`，否则 `unavailable` / `SQUARE_REPOSITORY_UNAVAILABLE`，所有路由 503 `CAPABILITY_UNAVAILABLE` / `SQUARE_REPOSITORY_UNAVAILABLE`，不返回空列表冒充。

### 2.1 `GET /v2/square/feed?scope=global|following&cursor=&limit=`

- 默认 `global`；`limit` 1..30（默认 20）；`cursor` 与 `limit` 互斥（游标携带页大小，绑定调用者 + 路由 + scope，换 scope 用旧游标 400）。
- 排序 `createdAt desc, postId desc`。**首页**（无游标）先列至多 3 条置顶官方帖（publish 新的在前，两个 scope 都列），后面接时间线；时间线本身不含置顶帖，翻页不会重复。
- `following` = 调用者 `follow_edges` 的关注对象的帖子（不含自己）。
- 可见性：用户帖只在作者 profile 为 active 且有 loopId、双方都没有 `user_blocks`（kind user）时出现；`system` 帖总可见。
- **需要登录**（任务单写「公开读、following 需登录」；仓库所有 /v2 读都要 Bearer，没有可选鉴权钩子，按 AGENTS 的保护边界不另开匿名读）。因此 `likedByViewer` 总有值。

```
{ scope, items: [{ postId, kind, author: {publicProfileId, loopId, alias, avatarRef} | null,
                   text | null,
                   token: { kind: meme|launch2, memeTokenId | null, instanceId | null, symbol,
                            logoUrl | null, priceUsd1 | null, change1hPct | null,
                            marketCapUsd1 | null } | null,
                   event: { …string | null } | null,
                   likeCount, likedByViewer, pinned, createdAt }],
  nextCursor | null, observedAt, contractVersion }
```

`author` 用 `publicProfileId` 而不是任务单写的 `userId`：内部用户 id 不出 API（AGENTS「Use random opaque LOOP user IDs」，0097 同样只外露 publicProfileId），且关注接口 `POST /v2/connections/follow/{publicProfileId}` 正好用它；`avatar` 为 `avatarRef`（与全仓库 identityProjection 一致，`avatar:media/{id}` 渲染为 `/v2/media/{id}.webp`）。

**报价**（只读数据库读模型，不在每次读时调 Provider）：

- MEME v1（`meme_tokens`）：trading / full / paused 时为曲线价、1 h 涨跌（对一小时前最新成交价，无则开盘价）、市值，与 `GET /v2/meme/tokens` 同一算法；已毕业的 v1 没有存储价格 → 三项 null；`logoUrl` = `/v2/media/{imageMediaId}.webp`。
- launch2（`launch2_instances`）：毕业前为曲线价 `price_e18`；毕业后为 `pool_last_price_e18`，1 h 涨跌对一小时前最新的 `launch2_pool_swaps` 价格（无则 null）；曲线阶段没有 1 h 参照价 → `change1hPct` null；市值 = 价格 × 1e9。
- 引用的代币读不到（删了 / 重置了）→ `token: null`。

### 2.2 `POST /v2/square/posts`

`Idempotency-Key`（UUIDv4，必填，同全部 /v2 写）；body `{text, tokenRef?}`，`kind` 恒为 opinion，直接 published。首写 201 `{post, contractVersion}`；同键同内容重放 200 同一帖；同键不同内容 409 `IDEMPOTENCY_CONFLICT`。事务内：锁作者行 → 查键 → profile 未激活 409 `PROFILE_ACTIVATION_REQUIRED` → 近 60 s 内已发 ≥ 5 条（含已删的）429 `RATE_LIMITED` / `SQUARE_POST_RATE_LIMITED` → 写入。

422 `VALIDATION_FAILED` + `detailsSafe.reasonCode` + `field`：`SQUARE_POST_TEXT_EMPTY`（trim 后为空 / 缺失）、`SQUARE_POST_TEXT_TOO_LONG`（> 500）、`SQUARE_POST_TEXT_INVALID`（控制字符〔换行除外，CRLF 归一为 LF〕、代理项、行 / 段分隔符、bidi 覆盖 / 隔离字符；ZWJ 等其它格式字符保留，emoji 组合可用）、`SQUARE_TOKEN_REF_INVALID`（形状不对、MEME v1 不存在或未上链、launch2 实例不存在）。多余字段 400。

### 2.3 `DELETE /v2/square/posts/{postId}`

只删自己的 opinion：置 `archived`（`archived_by = author`），从所有时间线消失，点赞保留；重复删 204。别人的帖、事件帖、官方帖、未知 id → 404 `NOT_FOUND`。

### 2.4 `PUT` / `DELETE /v2/square/posts/{postId}/like`

幂等（主键即去重；`Idempotency-Key` 照常必带，不另存）；返回 `{postId, likeCount, likedByViewer, contractVersion}`。帖子不是 published → 404。

## 3. 系统事件 lane：`square_feed_ingest`

worker 进程的周期 lane，`SQUARE_FEED_INGEST_ENABLED` 默认 **true**（只读写本库，不调外部），`SQUARE_FEED_INGEST_INTERVAL_MS` 默认 60 000。每轮对每个来源读近 7 天内、`square_posts` 里还没有的事件（anti-join `source_event_id`，所以不需要游标表），每源每轮至多 200 条，按事件时间升序写入；`on conflict (source_event_id) do nothing` 保证并发 / 重跑幂等。数据库错误退避 1 s → 60 s，不影响其它 lane。作者 = 事件对应的 LOOP 用户，且须有 active profile；映射不到用户的事件不写。

| kind         | 来源                                                                                                                                                                                                                                          | `source_event_id`                                  | `event`                                                                                                  | `tokenRef`                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `buy`        | `community_member_buy_events`（0097 已判定为群友买入且公开交易：outcome sent / truncated / rejected / skipped_no_channel）+ `indexed_pool_events` 的金额；稳定币侧（USD1〔已验证的 `BSC_USD1_TOKEN_ADDRESS`〕/ USDT / USDC，按面值）付出 ≥ 10 | `buy:{chainId}:{txHash}:{logIndex}`                | `amountUsd1`、`tokenAmount`、`transactionHash`                                                           | 绑定资产地址对上 MEME v1 / launch2 时给出，否则 null |
| `claim`      | `launch2_dynamic_claims` 未 removed（已索引 = confirmed）；`buyer_address` → active `account_wallets`；作者隐私 `trade_history_visibility = everyone` 且非匿名（同 0097 规则）                                                                | `claim:{chainId}:{txHash}:{logIndex}`              | `amountUsd1`、`roundId`、`weightPct`（该钱包占该轮买入权重 %，两位小数，取不到 null）、`transactionHash` | launch2 实例                                         |
| `graduation` | `launch2_instances.graduated_at`（作者 = 实例 owner）；`meme_tokens` status graduated（作者 = creator）                                                                                                                                       | `graduation:launch2:{id}` / `graduation:meme:{id}` | `transactionHash`（可空）                                                                                | 该实例 / 代币                                        |

同一笔 swap 匹配多个社群时只写一条（按 swap 去重）。报价侧的 WBNB 买入不计价，不写（不在 lane 里调行情）。

## 4. 后台：`/admin/v1/square/posts`（0140 写法）

| 路由                      | 权限            | 成功                                                                  |
| ------------------------- | --------------- | --------------------------------------------------------------------- |
| `GET …?status=&kind=`     | `console.read`  | 200 `{ items, generatedAt }`（≤ 200，按创建倒序）                     |
| `GET …/{postId}`          | `console.read`  | 200 `{ post }`                                                        |
| `POST …`                  | `console.write` | 201 `{ post, audit, replayed: false }`；同键重放 200 `replayed: true` |
| `PATCH …/{postId}`        | `console.write` | 200 `{ post, audit }`（`text` / `tokenRef` / `pinned` 任意非空子集）  |
| `POST …/{postId}/publish` | `console.write` | 200 `{ post, audit }`                                                 |
| `POST …/{postId}/archive` | `console.write` | 200 `{ post, audit }`                                                 |

后台 `post` = `{postId, kind, status, text, tokenRef, pinned, author: {publicProfileId, loopId, alias} | null, event, sourceEventId, likeCount, publishedAt, createdAt, updatedAt}`。

状态机：create → `system` draft；update 仅 `system` 的 draft / published；publish 仅 `system` draft（置 `published_at`）；archive 任意 kind 的 draft / published（审核下架用户帖 / 事件帖）；archived 为终态。拒绝：状态不允许 409 `ADMIN_CONFLICT` + `reasonCode = SQUARE_POST_STATUS_CONFLICT`（+ `status`、`kind`）；对非 system 帖 update / publish 409 `ADMIN_CONFLICT` + `SQUARE_POST_KIND_CONFLICT`。不存在 / 非 UUID 404 `SQUARE_POST_NOT_FOUND`；无仓库 503 `SQUARE_REPOSITORY_UNAVAILABLE`；422 码同 §2.2；多余字段 / 空 PATCH 400。

审计：同一事务 `select … for update` → 纯函数 `decideSquareAdminTransition` → 更新 → `insertAdminAuditRow`；`action` = `square.post.create|update|publish|archive`，`target_type = square_post`，before / after = `{kind, text, tokenRef, pinned, status}`。幂等：create 的键 + SHA-256（操作者 + 规范化字段）存在行上，advisory lock 串行化，同内容重放首个结果与首个审计引用，不同内容 409 `ADMIN_IDEMPOTENCY_CONFLICT`；update / publish / archive 接受键不去重。loop-admin 页面本批不做（只给接口与 OpenAPI）。

## 5. 迁移 000084

见 `migrations/000084_square_feed.ts`。`down` 直接 drop 两张表，不做数据保护。`latestMigrationName` 与各迁移测试头部断言升到 `000084_square_feed`；`requiredDatabaseRelations` 加两张表。000083（S187-api-a）不在本分支：两批合并顺序由主代理定，node-pg-migrate 按文件名顺序跑，若某库先跑了 000084 再合入 000083，需要 `--no-check-order` 或先合 000083。

## 6. 未做 / 待定

1. 匿名读未开放（§2.1）；`author.userId` 改为 `publicProfileId`（§2.1）。两处偏离任务单字面。
2. 买入帖只计稳定币报价侧（USD1 / USDT / USDC），WBNB 报价的买入不进时间线；设计稿「以 $3.40M 市值」的成交时市值没有存，App 用当前 `token.marketCapUsd1`。
3. 已毕业 MEME v1 没有库内价格，报价为 null（列表页的 DexScreener / pool slot0 读是网络调用，不放进时间线读）。launch2 曲线阶段没有 1 h 涨跌。
4. 没有举报、评论、转发、图片；用户帖不能编辑；没有按用户的点赞列表接口。
5. 首次启用 lane 会回填近 7 天的事件；更早的不写。
6. 频率限制按库内计数（每作者每 60 s 5 条，含已删），没有按 IP。

## 7. 测试

- 单测 `test/square-feed.test.ts`（12 条）：文案规则（trim、500 code point、换行 / ZWJ 放行、tab / bidi / 分隔符 / NUL 拒绝）、tokenRef 解析、首页置顶合并（≤ 3、去重、顺序）、买入 10 USD1 阈值与 6 位小数稳定币、报价投影（v1 曲线 / v1 毕业 null / launch2 曲线 / launch2 毕业 1 h 涨跌）、后台状态机全表、ingest 一轮；路由（能力位 available / unavailable + 503、401、首页置顶 + 游标翻页 + scope 绑定 + cursor/limit 互斥 + limit 31 / 未知 scope 400、201 / 200 重放、422 四码、429、409 幂等冲突、缺键 400、多余字段 400、删 204 / 404、点赞计数、后台 401 / 403 / 201 / 422 / 409 / 400 / 404）。
- 集成 `test/square-feed.integration.test.ts`（5 条，独立临时库）：时间线顺序 + 草稿不可见 + 置顶领先 + following + 拉黑过滤 + 三页游标 + 跨 scope 游标 400 + 点赞幂等计数与 likedByViewer + 删除；每分钟 5 条（第 6 条 429、窗口过后放行）+ 同键重放 / 冲突 + 未激活 409；后台 create 重放 / 冲突 → update → publish → 再 publish 409 → archive → 三种 409 + 五行审计 + 审核下架用户帖 + 用户帖不可改 409 kind；ingest：群友买入 12.5 USDT 写、9 USDT 不写，三笔 claim 只写可映射且公开的一笔（带 launch2 报价 0.003 / 市值 3000000），launch2 毕业一条，第二轮 0 条，直接重复写 0 行；迁移 down 一步再 up。
