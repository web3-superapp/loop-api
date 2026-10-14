# 0140 · 发射台运营活动卡：launch2_campaigns（S183-api，2026-10-14）

依据：主代理 S183 任务单（2026-10-14）与后台批次（S183-admin）六条对接假设；`docs/32-发射台Banner与NFT铸造页设计-2026-10-14.md` §7.6（运营活动卡：后台可配表 + 公开接口 + hero 混排）与 §8（账本台版式，数据层不变）；Decision 0095（媒体存储）、0102 / 0109（后台、角色与审计）、0135（`POST …/resolve` 的审计与权限写法）、0139（launch2 只读接口样板）。
范围：只在 `loop-api`。新增 migration `000081_launch2_campaigns`、一个 App 公开读接口、七个后台接口（两读五写）。不读链、不签名、不改 `/v1`、不改 `ops/*.env`。

## 1. 实体

`launch2_campaigns`（主键 `campaign_id`，UUIDv4，opaque）：

| 字段（API）              | 列                                   | 规则                                                                                               |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `title`                  | `title`                              | trim 后 1..24 字（按 code point；库约束 `char_length`），不含控制 / 格式 / 分隔符字符              |
| `subtitle`               | `subtitle`                           | trim 后 0..60 字；空串与 null 都存 null                                                            |
| `coverMediaId`           | `cover_media_id`                     | null 或一个 `media_objects` 中 kind = `campaign_cover` 的对象                                      |
| `coverUrl`               | （投影）                             | `PUBLIC_BASE_URL` + `/v2/media/{id}.webp`（与 MEME logo 同一个投影 `mediaAbsoluteUrl`），或 null   |
| `startsAt` / `endsAt`    | `starts_at` / `ends_at`              | RFC 3339；`endsAt > startsAt`（库约束兜底）                                                        |
| `ctaLabel`               | `cta_label`                          | trim 后 1..8 字，默认「查看」                                                                      |
| `link`                   | `link_kind` / `link_value`           | `route`：以单个 `/` 开头（拒绝 `//host`），无空白；`url`：`https://`、可解析、无用户名密码；≤ 1024 |
| `pinned` / `sortOrder`   | `pinned` / `sort_order`              | 默认 false / 0；`sortOrder` 为 32 位整数                                                           |
| `status`                 | `status`                             | `draft` / `published` / `archived`                                                                 |
| `createdBy`              | `created_by`（+ `created_by_actor`） | 后台账号 id；ADMIN_USERNAME 引导管理员为 null（`created_by_actor` 记用户名）                       |
| `createdAt`, `updatedAt` | 同名                                 |                                                                                                    |

索引：`(status, ends_at)`；`create_idempotency_key` 部分唯一索引（§5）。**没有外键**：不引用 `admin_accounts`（与 0110 起所有后台事实一致），也不引用 `media_objects`——大量集成测试 `truncate … media_objects` 不带 CASCADE，加外键会让它们全部失败；封面引用由 API 在每次写入时校验（封面对象不可变、不删除）。

`media_objects`（0095）最小改动：kind 增加 `campaign_cover`；`owner_user_id` 改为可空，约束 `(owner_user_id is null) = (kind = 'campaign_cover')`——封面没有 LOOP 用户 owner，用 kind 区分（任务单给的两种方案中选这一种：管理员账号 id 不是 `loop_users`，放不进现有外键列）。头像 / 社群 logo 的上传、ref 校验与读取不变；`GET /v2/media/{id}.webp` 同样能读封面（公开不可变资源）。`dev:reset-users` 只删 owner 在重置集合内的对象，封面不受影响；`launch2_campaigns` 归类 platform。

## 2. 状态机

| 动作    | 允许的当前状态    | 结果      | 拒绝                                                                                                           |
| ------- | ----------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| create  | —                 | draft     | 422（§4）                                                                                                      |
| update  | draft / published | 不变      | archived → 409；合并后窗口不合法 → 422 `CAMPAIGN_WINDOW_INVALID`                                               |
| publish | draft             | published | published / archived → 409 `CAMPAIGN_STATUS_CONFLICT`；已结束（`endsAt ≤ now`）→ 422 `CAMPAIGN_WINDOW_INVALID` |
| archive | draft / published | archived  | archived → 409                                                                                                 |

archived 是终态（不能再发布、不能再改）。published 可直接改，App 下一次读取即生效。

## 3. 接口

### 3.1 App：`GET /v2/launch2/campaigns`

鉴权与 Cache-Control 同 `GET /v2/launch2/instances`（Privy Bearer + `X-Loop-*` 头，`no-store`），挂在 `launch2` 模块下。返回 `status = published` 且 `endsAt > now` 且 `startsAt ≤ now + 7 天` 的，最多 10 条，排序 `pinned desc, sortOrder asc, startsAt asc`（再按 `campaignId` 定序）；每条 `state = live`（`startsAt ≤ now`）| `upcoming`。

```
{ items: [{ campaignId, title, subtitle, coverUrl, startsAt, endsAt, ctaLabel,
            link: { kind, value }, pinned, sortOrder, state }],
  observedAt, contractVersion }
```

公开项不含 `status`（恒为 published）、`coverMediaId`、`createdBy`、时间戳。只读数据库，**不依赖 Factory 配置**（Factory 未配置时其它 launch2 路由 503，本接口照常）；无仓库或读失败 503 `CAPABILITY_UNAVAILABLE` / `LAUNCH2_REPOSITORY_UNAVAILABLE`，不返回空列表冒充。SQL 与服务层（`selectPublicLaunch2Campaigns`）用同一条规则过滤排序。

### 3.2 后台：`/admin/v1/launch2/campaigns`

| 路由                          | 权限            | 成功                                                                      |
| ----------------------------- | --------------- | ------------------------------------------------------------------------- |
| `GET …?status=`               | `console.read`  | 200 `{ items, generatedAt }`（不传 status = 全部状态，≤ 200，按创建倒序） |
| `GET …/{campaignId}`          | `console.read`  | 200 `{ campaign }`                                                        |
| `POST …`                      | `console.write` | 201 `{ campaign, audit, replayed: false }`；重放 200 `replayed: true`     |
| `PATCH …/{campaignId}`        | `console.write` | 200 `{ campaign, audit }`                                                 |
| `POST …/{campaignId}/publish` | `console.write` | 200 `{ campaign, audit }`                                                 |
| `POST …/{campaignId}/archive` | `console.write` | 200 `{ campaign, audit }`                                                 |
| `POST …/cover`                | `console.write` | 201 `{ mediaId, coverUrl }`                                               |

`console.read` = platform_admin、auditor；`console.write` 只有 platform_admin（auditor / reviewer / testnet_acceptor 403 `PERMISSION_DENIED`，无 session 401，均在 `onRequest` 先于 body 校验）。`audit` = `{ auditId, seq, at }`，同 0135。不存在 / 非 UUID 404 `NOT_FOUND` `CAMPAIGN_NOT_FOUND`；无仓库或写失败 503 `CAPABILITY_UNAVAILABLE` `CAMPAIGN_REPOSITORY_UNAVAILABLE`。

PATCH 接受任意非空子集（后台每次发全部可编辑字段），`coverMediaId` / `subtitle` 为 null 时清除；未知字段 / 空 body 400。publish / archive 忽略请求体。

### 3.3 封面上传

`multipart/form-data`，唯一字段 `file`（只在本路由的插件作用域注册 multipart，同 `/v2/media`）。按魔数判断 PNG / JPEG / WebP（HEIC 拒绝），≤ 2 MiB，至少 600 × 300（建议 1200 × 600），统一存为 **1200 × 600 WebP（2:1 居中裁切，quality 82，去元数据）**，与头像同一套 sharp 处理与 `media_objects` 存储（`processCampaignCoverUpload`）。拒绝：422 `VALIDATION_FAILED` `CAMPAIGN_COVER_INVALID`，`detailsSafe.mediaReasonCode` 为 `MEDIA_TYPE_UNSUPPORTED` / `MEDIA_TOO_LARGE` / `MEDIA_DIMENSIONS_TOO_SMALL` / `MEDIA_DECODE_FAILED`；字段名不对 400。上传本身不写审计（引用它的 create / update 有审计）。

## 4. 校验与错误

路由 schema 只校验 JSON 类型（`link.kind` 枚举、`sortOrder` 整数范围、`pinned` 布尔、多余字段），所有长度 / 格式规则在服务层，保证返回 422 + `detailsSafe.reasonCode` + `field`：

- `CAMPAIGN_TITLE_INVALID`：title / subtitle / ctaLabel（`field` 指明哪一个；任务单只给了四个码，文案类共用这一个）。
- `CAMPAIGN_WINDOW_INVALID`：日期不可解析、`endsAt ≤ startsAt`（PATCH 按合并后的值判断）、发布已结束的活动。
- `CAMPAIGN_LINK_INVALID`：见 §1。
- `CAMPAIGN_COVER_INVALID`：`coverMediaId` 不是 UUID 或不是已上传的封面；上传文件不合格。

状态不允许：**409 `ADMIN_CONFLICT` + `detailsSafe.reasonCode = CAMPAIGN_STATUS_CONFLICT`**（+ `status` 当前状态）。后台错误目录没有 `CAMPAIGN_STATUS_CONFLICT` 这个顶层 code，按仓库惯例（0135 `CHAIN_GUARD_INCIDENT_ALREADY_RESOLVED`）放在 reasonCode。schema 里 `subtitle` / `coverMediaId` 的 `anyOf` 把 null 放在 string 前面：Fastify 的 ajv 开了类型强制，string 在前会把 null 变成 `""`。

## 5. 审计与幂等

- 每个写接口在**同一事务**里：`select … for update` → 判断（纯函数 `decide`）→ 更新 → `insertAdminAuditRow`（0135 导出的同一条 SQL）。`action` = `launch2.campaign.create|update|publish|archive`，`target_type = launch2_campaign`，`target_id = campaignId`，`before` / `after` 为全部可编辑字段 + status 的快照（create 的 before 为 null），`request_id`。拒绝的转换不写任何东西。
- `Idempotency-Key`（可选，小写 UUIDv4；格式不对 400）——后台对每个写请求都带：
  - create：键与「操作者 + 规范化字段」的 SHA-256 存在行上（`create_idempotency_key` 部分唯一索引，事务内 advisory lock 串行化同键请求）；同键同内容重放首个结果（200、`replayed: true`、首个 create 的审计引用，不新增审计），不同内容 409 `ADMIN_CONFLICT` `ADMIN_IDEMPOTENCY_CONFLICT`。
  - cover：键即 `media_objects.idempotency_key`（`campaign_cover` 范围内部分唯一）；同键同字节重放同一个 `mediaId`，不同字节 409。无键时用随机键。
  - update / publish / archive：接受键但不去重——publish / archive 第二次天然 409；PATCH 发全量字段，重复提交写入同样的值（多一行审计）。0135 的 resolve 同样不要求键；没有为这三个动作新建命令表。

## 6. 迁移 000081

见 `migrations/000081_launch2_campaigns.ts`。`down` 直接 drop 表、删除全部 `campaign_cover` 对象、恢复 `media_objects` 的 kind 约束与 `owner_user_id not null`，**不做「有数据就拒绝」的保护**（按任务单）。`latestMigrationName` 与各迁移测试的头部断言更新为 `000081_launch2_campaigns`，`requiredDatabaseRelations` 增加 `public.launch2_campaigns`。

## 7. 未做 / 待定

1. 后台列表响应为 `{ items, generatedAt }`（后台假设 `{ items }`；多一个字段，向后兼容）。
2. 封面上传没有单独的频率限制（只有 platform_admin 能调）；没有清理未被引用的封面。
3. 公开接口没有按用户 / 地区定向；没有点击统计。
4. App 侧 hero pager 混排与倒计时（docs/32 §7.6）不在本批。

## 8. 测试

- 单测 `test/launch2-campaigns.test.ts`（14 条）：公开接口过滤（draft / archived / 已结束 / 恰好结束 / 7 天外不出，恰好 7 天出）、live / upcoming、排序与上限 10、503 不返空、无 Bearer 401；五个写路径无 session 401、auditor / reviewer / testnet_acceptor 403 且无写入；读路径权限；完整状态机（含 archived 不能 publish / archive / patch、draft 直接归档、发布已结束 422）；四种拒绝码共 15 个用例 + PATCH 合并窗口 + 形状错误 400；审计行动作序列与快照；create 与 cover 的幂等重放 / 冲突；封面 1200×600 WebP 处理与四种 media 拒绝原因；无仓库 503。`test/helpers/launch2-campaign-fakes.ts` 的 `listPublic` 故意不过滤，测的是服务层规则。
- 集成 `test/launch2-campaigns.integration.test.ts`（3 条，独立临时库）：上传封面（库内 kind / 无 owner / 1200×600）→ 创建 → 幂等重放 → 公开读不到 → 发布 → 公开读到 → 改 → 归档 → 读不到 → 归档后发布 409，四行 `admin_audit_log`；SQL 过滤排序与窗口约束；迁移 down 一步再 up。
