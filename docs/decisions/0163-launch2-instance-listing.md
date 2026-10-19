# 0163 · launch2 实例列表隐藏（S245-api，2026-10-19）

## 1. Status

已实现（分支 `feat/S245-launch2-listing`，基线 `40921be`）。迁移 `000093_launch2_instance_listing`。**合并顺序固定：S238（000092）→ S245-api（000093）→ S243-api（000094）**；各分支按此顺序 rebase 时统一 `src/database/schema.ts` 的 `latestMigrationName` 与迁移测试里的最新迁移名（本分支写的是 000093）。新增两条后台路由；`/public/v1/meme/{id}` 加 `instance.listing`；**`/v2` 线上格式不变**（不下发 `listing`，见 §3.2），无新 `/v2` 路由、无新 `/v2` 错误码。

## 2. Context

staging 上有 4 个链上 MEME v2 实例名为「S137 Testnet S13xxxx」（2 个 `public`、2 个已毕业），需求方要求 App 页面不出现测试字样。实例是链上事实：不能删，也不该改名（名字来自已核验的 config，改了就和链上 / config hash 不一致）。MEME v1 已有同类能力（`meme_tokens.listing`，决策 0102），launch2 没有。

## 3. Decision

### 3.1 实体与状态

`launch2_instances` 新增四列（稳定 ID 仍是 `instance_id`，地址 / ticker 不作键）：

| 列                   | 类型                                                         | 说明                                                         |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `listing`            | `text not null default 'visible'`，check `visible \| hidden` | 现有行全部 `visible`，语义不变                               |
| `listing_reason`     | `text`，1–280 字                                             | 运营备注；`hidden` 时必填；恢复 `visible` 时不传则保留上一条 |
| `listing_updated_at` | `timestamptz`                                                | 最近一次修改时间；从未改过为 null                            |
| `listing_updated_by` | `text`，1–128 字                                             | 最近一次修改的后台 actor；从未改过为 null                    |

check `launch2_instances_listing_hidden_check`：`hidden` 必须同时有 reason / updated_at / updated_by。

状态机只有两态，`visible ⇄ hidden` 任意切换；写同一个值也成功（`changed: false`，照样记审计），与 MEME v1 一致。

### 3.2 读路径（默认过滤 `hidden`）

| 读                                                                              | 位置                                          | 行为                                                                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /v2/launch2/instances`（全部 / 任一 `stage`，含已毕业）                    | `launch2-repository.listInstances`            | `and listing = 'visible'`                                                                                |
| `GET /public/v1/meme`（官网列表，`all / curve / graduated`）                    | 同上（共用 `listInstances`）                  | 同上                                                                                                     |
| `GET /v2/launch2/overview` 计数（liveCount、graduatedTotal、nftMintedTotal 等） | `overviewFactsSql`                            | 同上                                                                                                     |
| `GET /v2/launch2/overview` 动态                                                 | `activitySql` 的 `visible` CTE                | 同上                                                                                                     |
| 广场时间线 / 置顶                                                               | `square-repository.listTimeline / listPinned` | 非 `opinion` 帖（buy / claim / graduation / system）且 `token_kind = 'launch2'` 指向隐藏实例的，不出列表 |

仍可读（持有人要能看自己的币）：

- `GET /v2/launch2/instances/{instanceId}` 及其下 quote / pool / dynamic-pool / buybacks / trades、`GET /v2/launch2/me/positions`、`GET /public/v1/meme/{instanceId}`（含 candles）、`GET /v2/square/posts/{postId}`。
- `/v2`（列表、详情、overview）**不下发 `listing`**：已发布 App 的 strict codec 遇到未知键会整页 `invalidPayload`（审查发现，主代理裁决方案 a）。以后 App 需要时，作为**可选键**随移动端版本一起下发。
- `/public/v1/meme/{id}` 的 `instance.listing`（必填）与后台接口保留 `listing`。

不过滤（有意）：

- 用户发的 `opinion` 帖：是用户内容，不因运营隐藏代币而消失；卡片照常显示代币（主代理裁决）。
- `GET /v2/launch2/me/positions`：持有人的持仓照常含隐藏实例。
- 广场入库 lane（`listBuyCandidates / listGraduationCandidates`）照常生成事件帖，只在读时过滤，所以恢复 `visible` 后历史事件帖自动回来。
- 全局搜索：`/v2/search` 目前不含 launch2（`assets` / `launch` 段为 `unavailable`），无需处理；以后接入时须带同一过滤。
- 行情分类 `category=meme`：只读 `meme_tokens`（v1），不含 launch2。
- indexer / keeper / snapshot publisher / 挖矿结算等 worker：按链上事实运行，不看 `listing`。

### 3.3 indexer 不覆盖

`registerActivatedInstances` 是 `insert … on conflict do nothing`，其余投影 `update` 都只列自己的列，没有任何写路径触碰 `listing*`。集成测试在隐藏后重跑 `registerActivatedInstances` 与 `updateStages`，确认仍为 `hidden`。

### 3.4 后台接口

均在 `/admin/v1`，cookie 会话，与 MEME v1 listing 同一权限位：

| 路由                                                   | 权限                              | 说明                                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/v1/launch2/instances?listing=&q=`          | `console.read`                    | 全部实例（两种 listing、所有链），按 `registered_at` 新→旧，**仅返回最新 200 条、无游标 / 分页**（更早的用 `q` 精确查 instanceId / 地址）；`q` 匹配名称 / ticker 子串、精确 instanceId、MEME 地址 |
| `PUT /admin/v1/launch2/instances/{instanceId}/listing` | `console.write`（platform_admin） | body `{listing: "visible"\|"hidden", reason?}`；同事务写 `admin_audit_log`：action `launch2.listing.update`，target `launch2_instance`，before / after `{listing, reason}`                        |

响应 `{instance, changed, audit}`，`instance` = `{instanceId, projectId, chainId, name, ticker, memeAddress, stage, graduatedAt, registeredAt, listing, listingReason, listingUpdatedAt, listingUpdatedBy}`。`stage` 是库里存的阶段（可能落后于时钟推导值）。

GET 列表不在任务单里，是为后台页面能找到实例 / 看当前状态而加；只读、无副作用。

### 3.5 错误码

不新增错误码，只新增一个 reasonCode：

| HTTP      | code                     | reasonCode                              | 何时                                                                                     |
| --------- | ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| 400       | `INVALID_REQUEST`        | —                                       | `listing` 不是 `visible \| hidden`（schema）、多余字段、`listing` 查询参数非法、`q` > 64 |
| 404       | `NOT_FOUND`              | `ADMIN_LAUNCH2_INSTANCE_NOT_FOUND`      | id 非规范 UUID 或不存在                                                                  |
| 422       | `VALIDATION_FAILED`      | `ADMIN_REASON_TEXT_REQUIRED`            | `hidden` 没给 `reason`（或去空白后为空）                                                 |
| 422       | `VALIDATION_FAILED`      | `ADMIN_REASON_TEXT_INVALID`（沿用）     | reason 超 280 字或含控制字符                                                             |
| 503       | `CAPABILITY_UNAVAILABLE` | `ADMIN_DATABASE_UNAVAILABLE` 等（沿用） | 无数据库：fail closed，什么都不写                                                        |
| 401 / 403 | 沿用会话错误             | —                                       | 未登录、无 `console.write`                                                               |

### 3.6 unavailable

无数据库时后台两条路由 503 `CAPABILITY_UNAVAILABLE`（沿用不可用仓库的 `fail`）；`/v2` 读路径的 unavailable 行为不变。

### 3.7 与 MEME v1 listing 的差异（主代理 2026-10-19 裁决保留）

|                  | MEME v1（0102）                     | launch2（本决策）                                             |
| ---------------- | ----------------------------------- | ------------------------------------------------------------- |
| 取值             | `listed \| hidden`                  | `visible \| hidden`                                           |
| 方法             | `POST …/meme/tokens/{id}/listing`   | `PUT …/launch2/instances/{id}/listing`                        |
| body             | `{listing, reasonCode, reasonText}` | `{listing, reason}`                                           |
| App 是否展示原因 | 是（`listingReasonText`）           | 否：`reason` 只进后台与审计；本批 `/v2` 连 `listing` 也不下发 |

原因：

1. **取值 `visible`**：launch2 实例没有「上架 / listed」流程（激活即出现在列表），`listed` 会被误读为交易所上币（03 §8.4 的 listing milestone 已用该词）；`visible` 只表达「是否出现在 App 列表」。
2. **`PUT`**：写的是实例的一个幂等属性（目标状态整体替换，重复写结果相同），PUT 语义更准；MEME v1 的 POST 是早期写法，不回改（`/admin/v1` 既有路由冻结）。
3. **单个 `reason`、不对用户展示**：本需求是下架测试项目，原因是给运营 / 审计看的内部备注，不需要 `reasonCode` 分类，也不该在 App 里出现「测试」字样；所以 App 拿不到原因。

其他裁决：用户 `opinion` 帖保持可见（§3.2）；`GET /admin/v1/launch2/instances` 保留（§3.4）；迁移号 000093 保留，合并顺序 S238（000092）→ S245-api（000093）→ S243-api（000094）。

## 4. Consequences

- 上线后运营在后台把 4 个「S137 Testnet」实例设为 `hidden` 即可（staging 需先跑迁移 000093）；不改链、不改名、可随时恢复。
- 持有人从持仓 / 直达链接仍能进详情并交易。App 暂不下发 `listing`；以后需要（如详情页提示）时作为可选键随移动端一起发。
- 待办（另批）：隐藏实例绑定的社区名可能也带「Testnet」字样（社区列表 / 广场仍可见），本批不处理。
- loop-admin 需要加的入口（不在本批）：
  1. 「MEME」菜单下新增「MEME v2 实例」列表页：调 `GET /admin/v1/launch2/instances`，筛选 `listing`、搜索框 `q`；列：名称、ticker、阶段、MEME 地址、listing、原因、最近修改人 / 时间。
  2. 行操作「隐藏」（弹窗必填原因，≤ 280 字）/「恢复」（原因可选）：调 `PUT …/listing`；仅 platform_admin 可见（`console.write`）。
  3. 可选：在发射项目详情（`GET /admin/v1/launch/projects/{projectId}`）的 MEME v2 区块加同一开关（用该项目最新实例的 `instanceId`）。
- 测试：`test/launch2-listing.integration.test.ts`（真实 PostgreSQL：默认 visible、隐藏后列表 / 已毕业 / overview / overview activity / 广场时间线 / 置顶都不含、持仓仍含、用户 opinion 帖仍在时间线、详情与帖子直达仍可读、审计 before/after、indexer 重跑不覆盖、恢复、check 约束、未知 id）；`test/admin-routes.test.ts`（422 / 400 / 404、隐藏、列表筛选、恢复、`changed: false`、审计条数）；`test/v2-launch2-routes.test.ts`、`test/v2-launch2-overview.test.ts`、`test/public-meme-routes.test.ts`（列表排除、`/v2` 列表与详情不带 `listing`、`/public/v1` 详情带 `listing: hidden`、计数不含）；`test/openapi.test.ts`（路由清单）。
