# GitNexus Engineering Plan

> Task: 将 LOOP V2 非合约产品按可独立联调的小模块拆分，明确后端交付顺序、接口边界、当前进度、前端交接门槛、依赖与整体排期。
> Evidence verified at commit 142c7541f71c0a23aee4a6c216cab58a5fcb4dfe; GitNexus index refreshed this session (`analyze --index-only --pdg`).
> Evidence provenance schema 2; global dirty digest 5c72bb6f8c4e2741e4ee3a24ffddb702dbe6db1aee13981fd69d13053c458197; cited-path manifest 32 sorted entries; exact generated plan path excluded.

## 1. Objective

把当前 `loop-api-spot` 演进为 LOOP V2 的后端，采用“后端完成一个纵切模块 → Development 部署 → 前端真机联调验收 → 再交付下一个模块”的方式推进。

[verified] 本计划以用户提供的 `/Users/mac/Downloads/03-非合约产品方案.md`（SHA-256 `825bf74eabfee1182a8e33664ee8d71be0a6a777ff716eba2c676fc95f64ef5b`）为产品权威输入：登录后进入 `community`，不存在 Home Tab；五个 Tab 为社区、挖矿、Launch、行情、钱包；普通 Token 使用 Privy Swap；链路改为 BSC / USD1 / PancakeSwap V3；Hyperliquid、Perp 和订单簿现货不属于新版范围。

本计划中的“Home”统一解释为登录后的 Community 首页聚合模块，不恢复旧 Home 路由或 Tab。

交付目标：

1. [inferred] 冻结 `/v1` 作为现有兼容面，新增 `/v2` 作为 camelCase、统一错误模型和 BSC 产品域的正式移动端契约，避免前端先接 snake_case 后整体返工。
2. [verified] 继续使用 Privy 作为身份凭据、钱包与签名 Provider，Stream 作为消息、在线、已读、历史和 RTC 真相源；BFF 不自建钱包、IM、RTC 或链上资金规则（`AGENTS.md`；`README.md`；`docs/product-decisions.md`）。
3. [inferred] 只允许一个模块处于“前端联调”状态；后端可以在不发布新公共契约的前提下并行准备 Provider、Indexer 和合约依赖。
4. [assumed] 排期按 2 名 BFF、1 名链/Indexer、1 名 QA 自动化、共享 DevOps/安全，以及独立前端团队估算；外部 Provider、合约、合规等待时间不计入纯开发工日，但计入日历风险。

### 模块状态门槛

| Gate | 含义 | 可否交给前端 |
| --- | --- | --- |
| G0 范围 | 产品语义和依赖未冻结 | 否 |
| G1 契约 | 决策、OpenAPI、DTO、错误、Mock/示例已冻结 | 只可做模型接入 |
| G2 后端 | 实现、迁移、单测、契约测试、数据库测试通过 | 否 |
| G3 Dev | `api-dev.quant-dinger.cc` 已部署，真实依赖或明确 fail-closed，冒烟通过 | 是 |
| G4 联调 | 前端真机正向、负向、重连、超时和恢复场景通过 | 模块完成 |
| G5 发布 | 安全、合规、运维、监控、备份和生产证据通过 | 可生产发布 |

模块不能因“有路由”或“有 2xx fake 测试”越级；Provider/真机证据缺失时最多停在 G2 或带限制的 G3。

## 2. Current Behaviour

[verified] 当前生成的 `openapi/loop-api.v1.json` 有 68 个 operation；其中 33 个属于 Hyperliquid Spot/Perp 或旧 transfer 面，与新版 BSC 产品闭环不再同路。现有 `/v1` 仍是 snake_case 响应和 lowercase error code（`openapi/loop-api.v1.json`；`src/app.ts:709-781`）。

[verified] `buildApp` 当前统一完成 Fastify、安全头、Privy verifier、PostgreSQL repository、Stream issuer、社交与全部路由的组合；路由 schema 同时是 OpenAPI 来源（`src/app.ts:272-783`; `scripts/generate-openapi.ts:35-132`）。

[verified] 每个受保护请求重新验证 Privy Bearer；`POST /v1/bootstrap` 首次创建或复用随机 LOOP UUID，并由服务端派生 Stream user ID。客户端不能传 owner、LOOP ID 或 Stream ID（`src/core/http/authentication.ts:1-170`; `src/features/identity/bootstrap-service.ts:1-37`; `src/routes/bootstrap.ts:13-72`）。

[verified] Chat/Video token 路由已组合官方 Stream issuer、持久额度和固定 3600 秒 TTL；服务先验证 principal，再原子消费 user/IP quota，最后签发 token，缺配置时 fail closed（`src/routes/stream-tokens.ts:40-113`; `src/features/communication/stream-token-service.ts:269-368`; `docs/decisions/0021-official-stream-token-issuer.md`）。

[verified] Profile、privacy、公开 Alias 搜索、好友申请/接受、好友列表、后端建群/私聊、群内不可变 Alias、Watchlist 和 inactive alerts 已有本地 PostgreSQL 契约。消息正文、历史、未读、typing、presence 和 RTC 仍由 Stream 提供（`src/routes/profile.ts:234-390`; `src/routes/discovery.ts:157-235`; `src/routes/social.ts:535-829`; `src/routes/chat-channels.ts:365-510`; `docs/decisions/0024-alias-discovery-and-group-personas.md`; `docs/decisions/0025-friend-graph-and-backend-created-stream-channels.md`）。

[verified] 2026-09-01 本会话实测：`pnpm test:contract` 为 30 个文件、605 个测试全部通过；`pnpm stream:verify` 通过；`https://api-dev.quant-dinger.cc/health/ready` 返回 PostgreSQL ready。没有运行需要真机 Privy access token 的 `pnpm identity-stream:smoke`，因此不能把 Privy/Stream 真机链路标成 G4（`package.json`; `scripts/identity-stream-smoke.ts`; `test/identity-stream-smoke.test.ts`）。

### 新版产品后端完成度基线

以下百分比是“面向 2026-09-01 新版产品的后端准备度估算”，不是验收通过率：

| 能力域 | 当前准备度 | 证据与缺口 |
| --- | ---: | --- |
| Fastify/OpenAPI/PostgreSQL/错误脱敏/额度/幂等基础 | 80–90% | 基础成熟；尚未有 v2 camelCase 契约、领域事件 outbox 和 BSC 配置 |
| Privy 登录后端与账号 bootstrap | 75–85% | 代码、凭据和 Dev 健康；缺真机 token、四种登录方式矩阵、v2 session/account 投影 |
| Profile/公开身份 | 50–60% | Alias/privacy/profile code 已有；LOOP ID 唯一性、头像上传、v2 字段语义未冻结 |
| 好友/搜索/Stream 频道协调 | 50–60% | consent、搜索、好友、私聊/小群操作已实现；缺 block/unfriend/follow/DM requests 与真机 Stream 证据 |
| Community 实体和 Community 首页 | 0–10% | 现有“小群”不能替代 Community、角色、审核和推荐聚合 |
| Stream Chat | 45–60% | token 和后端建频道具备；客户端连接、权限、历史/重连、官方社区群未验收 |
| Stream Voice | 15–25% | Video token 可复用；房间生命周期、角色、主持、重连和真机音频未实现 |
| Watchlist | 75–85% | v1 owner-bound CRUD 完成；需映射到 v2 Asset ID |
| Alerts/通知 | 25–35% | 定义和偏好存储存在；没有价格事实、评估器、outbox、FCM/APNs 或上下文 feed |
| BSC Asset/Market/Wallet read | 0–5% | 无 Asset Registry、BSC Indexer/RPC、确认/重组、行情/K 线/余额/历史 |
| Privy Swap/Send/Approval | 0–5% | 只有旧 default-closed transfer 和资金安全模式；无 BSC capability/quote/submit/reconcile |
| Launch | 0% | 无目录、审核、Indexer 投影、Intent；合约仍是外部阻塞项 |
| Mining/Referral/Reward | 0% | 无公式、快照、关系验证、排行、奖励账本 |

[inferred] 按新版产品加权，当前后端整体约 20–25%；“平台基础完成度高”不能等同于“新版业务完成度高”。

## 3. Relevant Architecture

### 保留的边界

- [verified] `src/app.ts` 继续拥有 HTTP composition 和跨切行为；`src/config.ts` 继续拥有 fail-closed 配置；route schema 继续生成 OpenAPI；迁移继续 append-only（`AGENTS.md`; `src/app.ts:272-783`; `src/config.ts:26-125,290-422`）。
- [verified] `src/features/` 放领域规则，`src/integrations/` 放 Privy、Stream、BSC RPC/Indexer/行情/推送等窄 Provider adapter，`src/database/` 只负责持久层（`AGENTS.md`）。
- [verified] `createPostgresDatabase` 当前集中组装 repositories，并由 readiness 验证 migration head 和 required relations；新领域应沿用这一模式（`src/database/database.ts:96-236`）。
- [verified] command-style 写操作已有 UUIDv4 idempotency、durable operation polling 和 ambiguous result reconciliation 模式；CAS replacement 已有 expected version 和 same-value retry 模式（`docs/decisions/0009-personalization-alerts-api.md`; `docs/decisions/0025-friend-graph-and-backend-created-stream-channels.md`; `migrations/000013_social_chat_closed_loop.ts`）。
- [verified] Decision 0020 已冻结继续开发 Hyperliquid；新模块不得借用旧 Spot/Perp 路由表达 BSC Swap 或 Wallet（`docs/decisions/0020-spot-write-start-admission-and-freeze.md`）。

### 新的版本与运行时边界

- [inferred] `/v1` 原样冻结并只做严重漏洞修复；所有新版页面使用 `/v2`。v2 公共 DTO、错误、事件统一 camelCase，不把 database snake_case 泄漏到 wire。
- [inferred] 同一 Fastify 进程可同时注册 v1/v2，但 v2 应由一个独立 versioned composition 模块挂入 `buildApp`，避免继续把数十个领域直接堆进当前 500 行组合函数。
- [inferred] BSC Indexer 在同一仓库内作为独立进程/镜像运行，使用独立 checkpoint、回填、确认和 reorg 投影；API 进程只读取已标记 freshness/finality 的投影。
- [inferred] Community/PostgreSQL 拥有社区业务实体、角色和审核状态；Stream 拥有消息、通信 membership projection 和 RTC 状态。两者不同步时，业务详情可只读，但 Chat/Voice fail closed。
- [inferred] 所有资金公开数值使用 `amountAtomic` 字符串 + `decimals`，展示小数由客户端/mapper 产生；禁止 JavaScript `number` 处理金额、价格、余额、费用和比例。
- [inferred] v2 的每个 write 均要求 UUIDv4 `Idempotency-Key`，包括 CAS replacement；`expectedVersion` 继续负责并发，key 负责 lost-response recovery。v1 保持现有语义以免破坏兼容。

### 依赖主链

```text
D0 契约/版本
└─ D1 登录注册 → D2 LOOP ID/Profile → D3 Community 首页
   ├─ D4 Community 发现/详情 → D5 成员/角色/治理
   └─ D6 用户/好友/安全 → D7 Chat/DM/小群 → D8 Voice

D0 → D10 Asset Registry/BSC Indexer
      ├─ D11 Market/Token → D13 Watchlist → D14 Alerts/通知
      ├─ D12 Wallet 只读 → D15 Privy Swap → D16 Send/Approvals
      └─ D17 Launch 目录 → D18 Launch 链上 → D19 Mining/Referral

D9 全局搜索依赖 D4 + D6 + D10 + D17 的可检索投影
D20 Security/Settings 横切 D1、D12、D14、D16
```

## 4. GitNexus Findings

- [graph] `query(search_query="Fastify app composition route registration Privy authentication bootstrap Stream token", repo=<loop-api-spot>)` 找到 `buildApp`、`registerBootstrapRoute`、`registerStreamTokenRoute` 和 `loadConfig`；关键输出：“`Function:src/app.ts:buildApp`” 与“`RegisterBootstrapRoute → NoStoreResponseHeaders`”。源文件已确认这些是当前身份/通信组合入口。
- [graph] `query(search_query="profile alias discovery friends friend requests Stream group direct channel idempotency reconciliation", repo=<loop-api-spot>)` 找到 `000012/000013` migrations、`createPostgresSocialRepository`、Chat operation repository 和 chat-channel contract；关键输出：“`RefreshOperation → ChatChannelRepositoryUnavailableError`”。这证明现有 durable operation/reconciliation 是 Community/资金异步操作可复用的实现模式，而不是只存在于文档。
- [graph] `query(search_query="watchlist alerts repository postgres migration route tests service composition", repo=<loop-api-spot>)` 找到 `000005_personalization_alerts`、watchlist/alert repositories 和现有 route tests；关键输出：“`ReplaceNotificationPreferences → WatchlistRepositoryUnavailableError`”。源代码确认 Alerts 当前仅是存储边界，不是 evaluator/delivery。
- [graph] `context(name="buildApp", file_path="src/app.ts")` 显示其直接调用 authentication、database、bootstrap、Stream token、social、chat、profile、watchlist、alerts 和旧交易服务；incoming 包含 `src/server.ts`, OpenAPI generator 和测试 harness。新版本的组合、OpenAPI 与回归测试必须一起变更。
- [graph] `impact(target="buildApp", direction="upstream", maxDepth=3, includeTests=true, summaryOnly=true)`：risk `MEDIUM`，11 个受影响符号，depth-1 为 7，涉及 server、OpenAPI 生成和既有测试。
- [graph] `impact(target="registerSocialRoutes", file_path="src/routes/social.ts", direction="upstream", maxDepth=3, includeTests=true)`：risk `LOW`，直接依赖为 `buildApp` 和 `test/social-routes.test.ts:createApp`，transitive 包含 server、OpenAPI test 和其他 buildApp harness。新增 v2 social adapter 应独立注册，避免修改 v1 registrar 语义。
- [verified] GitNexus MCP 进程在本次 CLI 1.6.10 刷新后仍使用旧 LadybugDB storage runtime，MCP query 报 storage version 42/43；因此本计划的 graph 查询使用同版本 1.6.10 CLI，所有 load-bearing 结论再由 source/test 验证。该限制不影响源代码事实，但后续应重启/升级 MCP runtime。

## 5. Statement-Level PDG Findings

- [graph] `impact(target="buildApp", mode="pdg", direction="upstream", maxDepth=3, includeTests=true)` 成功读取 PDG，但 whole-symbol upstream slice 没有 statement-level affected statements；工具说明整个函数已作为 seed，需行锚点才有局部 slice。它仍通过 callgraph bridge 返回 11 个 interprocedural dependents，风险为 `UNKNOWN`，不能解释成低风险。
- [verified] 源码给出的关键顺序为：Fastify/Swagger/helmet → Privy verifier/database/auth hooks → Stream/social/chat 与其他 services → route registration → OpenAPI endpoint/not-found/error handler（`src/app.ts:272-783`）。计划含义：每个模块先形成独立 service/repository/route，再在最后一步接入 composition；OpenAPI golden 只在模块末尾统一更新。
- [verified] `createStreamTokenService.issueToken` 的顺序是 request/principal 校验 → abort check → 原子 user/IP quota → 再次 abort → 固定 TTL issuer → 再次 abort → 返回 token（`src/features/communication/stream-token-service.ts:269-368`）。v2 只能映射字段名，不能把 quota 放到签发之后或缓存 issued token。
- [verified] `registerSocialRoutes` 对 command POST 先做严格 header/body guard，再认证，再由 service 执行；读操作与 CAS replacement 使用不同 guard（`src/routes/social.ts:535-829`）。v2 的统一幂等要求需要新 versioned route，而不是改变 v1 guard。
- [verified] `registerChatChannelRoutes` 在非终态返回 202、stable `Location` 和 `Retry-After`，GET 会继续恢复/对账；这应成为 Swap、Send、Launch 和其他 unknown-result 写操作的公共交互模式（`src/routes/chat-channels.ts:365-510`）。

## 6. Proposed Changes

### 6.1 一次性架构与契约调整

| File/area | Source-verified symbol | Responsibility and intended change |
| --- | --- | --- |
| `docs/decisions/0026-v2-bsc-product-baseline.md` | N/A（新文档，不命名新代码 symbol） | 记录 2026-09-01 产品文档覆盖旧 Hyperliquid 范围、v1 freeze、v2 wire 规则、BSC Development/Mainnet gate、Community/Stream truth boundary |
| `docs/api-v2-conventions.md` | N/A | 冻结 camelCase、opaque ID、atomic amount、pagination、error envelope、idempotency、request/client/contract version headers、operation polling |
| `src/app.ts` | `buildApp` | 只新增一个 versioned composition 接入点；保留 v1 registrar，不在这里继续堆积每个新领域的细节 |
| `src/config.ts` | `loadConfig` | 增加按模块分组且 fail-closed 的 v2/BSC/Indexer/行情/推送配置；资金、Mainnet、Bridge、Pay 默认关闭 |
| `src/database/database.ts` | `createPostgresDatabase` | 逐模块挂接新 repository；每次 append-only migration 后 readiness 增加 relation 验证 |
| `scripts/generate-openapi.ts` | `renderOpenApiArtifact` | 保留 v1 golden，并生成独立 `openapi/loop-api.v2.json`；禁止手改 artifact |
| `src/routes/bootstrap.ts` | `registerBootstrapRoute` | v1 保持不变；身份逻辑通过新 v2 adapter 复用，不改变现有 snake_case contract |
| `src/routes/stream-tokens.ts` | `registerStreamTokenRoutes` | v1 保持不变；v2 只映射 camelCase，不改变 TTL、quota、server-derived ID 和 no-store |
| `src/routes/profile.ts` | `registerProfileRoutes` | v1 保持不变；Profile/LOOP ID 新语义进入 v2，不直接重写旧 CAS contract |
| `src/routes/discovery.ts` | `registerDiscoveryRoutes` | 复用 alias search/quota 基础；v2 搜索统一 stable ID/destination，不暴露 wallet/Privy/Stream ID |
| `src/routes/social.ts` | `registerSocialRoutes` | 复用 consent/idempotency/cursor 模式；unfriend/block/follow/DM request 作为 v2 新资源 |
| `src/routes/chat-channels.ts` | `registerChatChannelRoutes` | 复用 durable fixed-ID channel operation；Community 官方群和用户小群使用不同 kind/权限 |

所有新领域代码放在 `src/routes/v2/`, `src/features/<domain>/`, `src/integrations/<provider>/` 和 `src/database/`；本路线图不预先命名尚不存在的代码 symbol。开始每个模块前，为该模块生成一次窄化实施计划并做 impact/source verification。

### 6.2 模块交付路线图

估时为专注该模块的小组日历时间，不含前端自己的实现时间和外部审批等待；`当前` 是新版产品准备度。

| ID | 模块 / 对应页面 | 当前 | 后端交付与建议 v2 API | 前端 G4 验收 | 依赖 / 估时 |
| --- | --- | ---: | --- | --- | --- |
| D0 | 契约、环境与发布基线 | 45% | Decision 0026；v1 freeze；v2 conventions/error envelope；`GET /v2/meta/client-policy`、`GET /v2/meta/capabilities`；双 OpenAPI artifact；模块 feature gate | App 能按 min version、region、capability 进入正确 loading/blocked/unavailable；不依赖 hardcode | 无；3–5 天 |
| D1 | 登录与注册：splash/auth/otp/auth-wallet | 80% backend / 0% device | `POST /v2/session/bootstrap`、`GET /v2/account/me`、`POST /v2/session/logout`；首次 bootstrap 即 LOOP 注册，不另建密码注册 API；同一 Privy token path 支持 Email/Apple/Google/外部钱包；session 仅作审计/设备投影，Privy Bearer 仍逐请求校验 | 四种入口逐项：首次、重复、token 过期、取消、弱网、登出；同一已链接 Privy 账号返回同一 accountId；未链接账号不得自动合并 | D0、Privy dashboard/linking policy；5–8 天；第一批正式交付 |
| D2 | LOOP ID/Profile onboarding：loop-id-setup/profile-edit/privacy | 55% | `GET/PUT /v2/profile`、一次性 `POST /v2/profile/loop-id`、`GET/PUT /v2/profile/privacy`；冻结 loopId 字符集/唯一性/变更规则；alias 可变、群 alias 独立且不可变；avatar storage 未选时 capability unavailable | 新用户完成 LOOP ID 后进入 community；重复/保留词/敏感词/并发冲突；重装后恢复；默认头像和上传不可用态 | D1、LOOP ID 决策、头像存储；6–10 天 |
| D3 | Community 首页（用户所称 Home） | 5% | `GET /v2/community/home` 聚合已加入/推荐/最近社区、safe unread projection、capability/freshness；只返回真实 Development communities；AI/推荐未接时明确 unavailable | 登录默认落 community；区域级 loading/empty/error/partial；点击 stable destination；断网不伪造未读/在线 | D2、最小 Community schema；8–12 天 |
| D4 | Community 发现与详情：discover/profile/token-card | 5% | `GET /v2/communities`、`GET /v2/communities/{communityId}`、Token Card/verification evidence；游标分页、审核状态、asset 绑定可空；推荐先用版本化运营规则 | 列表/空态/分页/详情；验证证据和 observedAt；无绑定资产时不拼 Token；推荐原因可解释 | D3；8–12 天 |
| D5 | Community 成员、角色与治理 | 0% | join/leave、membership、members、Owner/Admin/Moderator、公告、禁言/封禁/举报、role audit；PostgreSQL 业务 membership/role 与 Stream communication projection 分离；Admin RBAC/four-eyes | Owner/Moderator/普通成员越权矩阵；加入/离开/封禁后 Chat 和 Voice 权限同步；Provider 不一致 fail closed | D4、Stream 权限、200k Go/No-Go；2–3 周 |
| D6 | 用户发现、好友与安全：connections/blocklist/dm-requests | 55% | 将现有 alias/friend request/list/search/operation 映射到 v2；新增 unfriend、block/unblock、follow/follower（若产品确认）、DM request、举报；不可发现/不存在/被 block 的外显一致 | 两账号搜索→申请→接受→好友；拒绝/过期/反向请求/重复 key；unfriend/block 后即时禁止新 DM/邀请；隐私不泄漏 | D2；8–12 天 |
| D7 | Stream Chat、DM 与小群：community-chat/dm/group/search/forward | 55% backend / 25% E2E | v2 Chat token adapter；后端创建 Community 官方群、direct、小群并返回 canonical CID；operation poll/reconcile；消息、历史、typing、presence、read、search/forward 继续由 Stream SDK；验证客户端无建群/改成员/保留字段权限 | 两台真机：token、连接、重连、历史、未读、DM 收敛、小群创建、重启恢复、权限负向；不宣称 E2EE | D5、D6、Stream dashboard；2–3 周 |
| D8 | Voice Rooms：voiceroom/voiceroom-full | 20% | 复用 Video token；增加 room metadata/lifecycle、host/speaker/listener、举手/批准、社区权限、operation audit；媒体状态仍由 Stream Video/Audio | 两台真机语音加入/退出/举手/主持/弱网/后台/麦克风拒绝/重连；后台不伪造人数/在线 | D5、D7、Stream plan/capability；2 周 |
| D9 | 全局搜索与聊天搜索边界 | 10% | `GET /v2/search` 返回 `resultType + stableId + displaySnapshot + destination`；独立 domain adapters；聊天搜索仍由授权 Stream conversation；URL/DApp 规范化与风险 gate 独立 | Community 入口搜索用户/社区/Asset/Launch；权限过滤、分页、重复名称、未知 URL 阻断；聊天正文不进入全局索引 | D4+D6+D10+D17；2–3 周，可延后到各索引就绪 |
| D10 | BSC Chain/Asset Registry/Indexer 基础 | 0% | canonical chain/asset/pool IDs；BSC RPC 多端点；ERC-20/Pancake V3 日志；checkpoint/backfill/confirmation/reorg；独立 worker；USD1/Pancake 地址只在官方+链上核验后进入 registry；read freshness API | 开发数据能追溯到 block/tx/log；重复事件幂等；深重组回滚；RPC stale/partial 明确；任何未核验地址不触发资金动作 | D0、RPC/Indexer provider；4–6 周，关键基础设施 |
| D11 | Market 与 Token：market/token/chart/holders/trades/new-pairs | 5% | market overview、asset facts、candles、holders、trades、new pairs、source/fetchedAt/TTL/quality；行情和安全 provider adapters；不提供订单簿或交易 venue 选择 | 每块独立 loading/stale/partial；K 线周期；holder exclusions；成交确认；Token 只在 capability swappable 时显示 Swap | D10、行情/安全 Provider；4–6 周 |
| D12 | Wallet 只读与多钱包：wallet/networth/asset/receive/wallets/tx-history/networks | 5% | Privy embedded/external wallet inventory；active wallet；BSC balances/activity/receive；display/available/spendable/gas/pending 分离；snapshot/finality/capability；wallet 地址不作账号 ID | 嵌入式+外部钱包切换；余额/净值时间；收款二维码；pending/reorg；断网只读；无支持钱包时明确下一步 | D10、Privy wallet capability；4–6 周 |
| D13 | Watchlist | 80% | 复用现有 owner-bound grouped CRUD，映射为 v2 assetId/camelCase/idempotency；验证 asset 存在但不把 watchlist 当市场事实 | 添加/删除/排序/分组；并发版本冲突；离线恢复；Market/Token 同步 | D10；3–5 天，可提前于完整 Market 交付 |
| D14 | Alerts 与上下文通知：alerts/notif-settings | 30% | 价格事实 evaluator、scheduler、trigger/outbox、device-token lifecycle、FCM/APNs、context feed/read ack/dedupe；安全通知强制策略；无独立通知中心 | 真机前后台推送、点击回原上下文、重复去重、权限拒绝、过期 payload 重拉、价格 stale 不触发 | D10+D11、Firebase/APNs、隐私；3–5 周 |
| D15 | Privy Swap：swap/swap-route/tx-result | 0% | 先做 BSC capability Go/No-Go；capability→quote→simulation→immutable intent→user signature→single submit→reconcile；普通 Swap 与 Launch intent 完全隔离；quote expiry、atomic amounts、unknown-result lock | 小额 allowlist canary：成功、用户取消、quote 过期、余额不足、chain mismatch、approval 成功但 swap 失败、submission unknown、重启恢复 | D10+D12、Privy BSC Swap POC、Mainnet 安全决策；4–6 周，外部 gate 可能阻塞 |
| D16 | Send、Approval Guard、Approvals、统一 Tx Result | 5% | recipient preflight、immutable send intent、decoded approval review、exact allowance 默认、revoke、attempt/reconcile；不复用旧 negative transfer 作为 success；任意 calldata 默认拒绝 | 发送/取消/失败/unknown；地址扫描、chain mismatch、gas reserve；授权与业务结果分离；撤销后链上复核 | D10+D12、Privy signing capability、安全 Provider；4–6 周 |
| D17 | Launch 目录、详情、申请与 Admin 只读流程 | 0% | project/launch/round stable IDs；draft/apply/attachments/KYB status；审核版本、双人复核、证据；只读链上四轴 projection slots；未部署合约时不可购买 | 列表/详情/申请草稿/退回重提；配置版本；无合约时明确不可执行；fixture 参数不入生产 | D4+D10、Admin identity/storage；4–6 周 |
| D18 | Launch 链上参与、退款、Claim、毕业 | 0% | 按冻结 ABI/地址/event 接入资格、USD1 allowance、purchase intent、PurchaseRecord、Entitlement、RefundLiability/Claim、vesting、四轴 digest、V3 evidence；未毕业仅买不卖 | 测试网全状态机、确认/reorg、退款聚合、claim maturity、状态变化使 intent 失效、毕业后新建普通 Swap 而非自动转换 | D15+D17、合约开发/审计/部署、USD1/V3 地址；8–12 周，不含合约实现 |
| D19 | Mining、排行、奖励与五级邀请 | 0% | versioned formula/snapshot/price protection；wallet balance evidence；资产/社区 power；10/5/3/2/1 referral edges、防环/女巫/失效；reward ledger/claim projection | 快照可追溯；价格 stale 停止推断；层级/上限/封禁/回滚；estimated 与 claimable 不混淆；重复 claim 不成功 | D10+D12+D18、公式/预算/奖励权威；6–10 周 |
| D20 | Profile 汇总、安全、设备、设置、支持 | 10% | DeviceSession、lastSeen/revoke、MFA/recovery capability、notification/privacy/settings、about/support ticket；key export 仅 Provider+step-up+安全 gate；服务端永不接触明文 key | 设备撤销、异常设备、能力 unavailable、客服脱敏、强验证、退出；Privy 不支持的恢复方式不显示成可用 | D1+D2+D12+D14；3–5 周，可分小片穿插 |
| D21 | 暂缓/独立 Go/No-Go | 0% | Bridge、Pay 执行、DApp Browser、Community AI、smart-money、外部交易所里程碑不进入核心串行计划；页面只可展示明确 unavailable/read-only，分别立项 | 不出现 fake success、无证据风险结论或资金入口 | 各自 Provider/合规/安全决策；不估时 |

### 6.3 每次给前端的标准交付包

每个模块到 G3 时必须一次性交付：

1. commit SHA、部署时间、Development Base URL 和 feature flag；
2. 该模块冻结后的 OpenAPI 片段、artifact digest、字段/枚举说明；
3. 正向请求示例、所有稳定错误 code、HTTP/retry/unknown-result 表；
4. Development 测试账号/真实 seed entity（不含 secret，不使用 production fixture 冒充事实）；
5. curl/operator smoke、数据库 migration head、Provider capability 证据；
6. 前端真机验收清单、已知 unavailable 项和回滚方式；
7. 前端确认 G4 后，在进度表记录通过日期、设备/系统版本、证据链接和遗留问题。

## 7. Implementation Sequence

### 通用模块循环

每个 Dn 都按以下顺序执行，任何一步失败都不交给前端：

1. 冻结模块决策、实体/ID、状态机、权限、数据来源、错误和 Go/No-Go。
2. 先写 v2 OpenAPI/contract tests 与 fail-closed unavailable contract。
3. 追加 migration/repository，并跑数据库 integration tests。
4. 实现 feature service 和窄 Provider adapter；成功、超时、限流、malformed、stale 和 abort 全覆盖。
5. 在 `buildApp` 的 versioned composition 接入模块，生成 OpenAPI，一次更新 golden。
6. 跑完整门禁，部署 Development，执行 credentialed smoke（若涉及 Provider）。
7. 生成标准交付包，前端开始 G4；本模块未 G4 前不再交付下一个模块的公共 API。

### 执行波次

1. **Wave A — 契约与身份（D0→D1→D2）**：先消除 v1/v2、camelCase、error、LOOP ID 和 account-linking 返工风险。D0+D1 是第一批前端交付，目标为开始后 7–10 个后端工作日；D2 随后 6–10 个工作日。
2. **Wave B — Community 首页与社区骨架（D3→D4→D5）**：D3 单独交付 Community 首页，不等待 Chat；D4 再交付发现/详情；D5 最后交付成员和治理。
3. **Wave C — 社交通信（D6→D7→D8）**：已有好友/频道代码先迁入 v2，再做两台真机 Stream Chat；Voice 只在 Chat 权限/身份稳定后开始。
4. **Wave D — 搜索/链数据准备（D10 基础优先，D9 延迟聚合）**：链/资产团队可在 Wave A–C 后台准备 D10，但不提前发布不稳定 API；D9 等可搜索域至少三个就绪后再交付。
5. **Wave E — Market/Wallet 只读（D11→D12，并穿插 D13）**：先建立客观、带 freshness 的只读事实；Watchlist 可在 Asset ID 冻结后快速交付。
6. **Wave F — 通知与资金动作（D14，D15→D16）**：Privy BSC Swap POC 必须在 D15 正式编码前完成。若 POC 不通过，Swap 保持 unavailable，不用自建路由替代。
7. **Wave G — Launch/Mining（D17→D18→D19）**：先完成不收资金的目录/申请/Admin；链上模块只在合约版本、地址、事件和审计证据冻结后接入；Mining 最后读取稳定的持仓与 Launch 事实。
8. **横切 D20**：设备/安全/支持按依赖拆成小片，但独立交付；D21 不占核心排期。

### 日历级总体估算

[assumed] 在 §1 团队配置、前端单联调通道和外部决策及时到位的前提下：

| 里程碑 | 累计日历时间 | 包含 |
| --- | ---: | --- |
| Identity-ready | 3–5 周 | D0–D2 全部 G4 |
| Community/Chat MVP | 11–17 周 | D3–D8 G4，含两台真机 Stream |
| Read-only BSC MVP | 21–33 周 | D10–D13 + Market/Wallet 只读；D9 可用 |
| 可交易核心 MVP | 27–43 周 | D15 Swap + D16 Send/Approvals，前提是 Privy/BSC gate 通过 |
| 非合约 V1 完整面 | 39–63 周 | D17–D20；Launch/Mining 外部依赖全部按时 |

团队规模换算：6–8 人跨职能并行约 30–42 周；3–4 人约 50–70 周；严格单后端串行约 65–90+ 周。以上不包含合约实现/审计本身，也不包含 Provider、合规或商店审批的不可控等待。

## 8. Test Strategy

### 每模块固定自动化

- Route contract：未知字段、重复 header、未认证、bootstrap 缺失、owner 越权、camelCase-only、no-store、request/correlation ID、错误脱敏。
- Repository integration：migration up、约束、并发 winner、idempotency replay/conflict、CAS、cursor owner binding、rollback refusal、readiness relation。
- Service behavior：成功、timeout、abort、rate limit、malformed provider、stale evidence、dependency unavailable、lost response、unknown reconciliation。
- OpenAPI：`renderOpenApiArtifact` 确定性、v1 不漂移、v2 operation/response surface 精确（扩展 `test/openapi.test.ts`）。
- Security：secret scanning、日志字段、客户端不能提交 owner/Privy/Stream/wallet authority、金额不使用 number、Provider URL/calldata allowlist。

### 关键新增测试文件/场景

| Test file | Scenarios |
| --- | --- |
| `test/v2-session-routes.test.ts` | first Privy principal → one account/session；repeat → same account；invalid/expired token → 401；unlinked identities → no merge；logout → session audit without trusting client owner |
| `test/v2-profile-routes.test.ts` | unique loopId race；reserved/sensitive terms；alias mutable；group alias untouched；idempotent CAS replay/conflict |
| `test/v2-community-home-routes.test.ts` | joined/recommended/empty；partial Stream unread；stable destination；unavailable provider clears fake data |
| `test/v2-community-routes.test.ts` | pagination；join/leave；role matrix；ban/mute；Stream projection mismatch |
| `test/v2-social-safety-routes.test.ts` | unfriend/block/follow/DM request；enumeration-resistant target response；operation recovery |
| `test/v2-search-routes.test.ts` | heterogeneous stable IDs；domain timeout partial result；permission filtering；URL homograph/redirect blocked |
| `test/bsc-indexer-*.integration.test.ts` | checkpoint/backfill；duplicate log；confirmation promotion；removed log/deep reorg；provider disagreement |
| `test/v2-market-routes.test.ts` | TTL/quality/partial；asset/pool identity；candles；holders exclusion；unconfirmed trades |
| `test/v2-wallet-routes.test.ts` | multiwallet owner mapping；active wallet；balance categories；pending/reorg；address never identity |
| `test/v2-swap-*.test.ts` | capability→quote→simulation→intent；expiry/digest; approval split；single submit；unknown lock/reconcile；Launch asset blocked before graduation |
| `test/v2-launch-*.test.ts` | four-axis digest/block binding；purchase vs entitlement/refund；no pre-graduation sell；reorg；claim maturity |
| `test/v2-mining-*.test.ts` | formula/version/snapshot；5-level weights；cycle/sybil/ban；stale price；estimated vs claimable |
| `test/v2-notification-*.test.ts` | outbox/dedupe；mandatory security rule；device revoke；payload context re-fetch；no sensitive amount/address |

### Credentialed/真机验收

- D1：Email、Apple、Google、外部钱包逐项真机；后端只接收 Privy access token，不接收 refresh token。运行 `pnpm identity-stream:smoke` 时 token 仅通过隐藏 stdin 输入，不发到聊天或命令参数。
- D7/D8：两台实体手机、两个真实账号、真实 Development Stream App；Chat reconnect/history/permissions 与 Voice weak-network/background/microphone cases。
- D10–D16：真实 BSC RPC/Indexer sandbox 或经决策批准的小额 canary；资金动作必须覆盖 stale、reorg、unknown 和重复提交。
- D14：真实 APNs/FCM 前后台、权限拒绝、token rotate、点击 context reload。
- D18：冻结版本的测试网合约完整事件和 reorg 证据；不能用 mock 代替资金验收。

### 现有和最终验证命令

这些命令已在 `package.json` 定义；涉及 DB/Provider 的模块还需对应 credentialed gate：

```sh
pnpm install --frozen-lockfile
pnpm secrets:check
pnpm test:contract
pnpm test:integration
pnpm test:worker
pnpm check
pnpm docker:build:migration
pnpm docker:build:runtime
pnpm docker:build:worker
docker compose config --quiet
```

身份/Stream 模块追加：

```sh
pnpm stream:verify
pnpm identity-stream:smoke
```

## 9. Risk and Impact Analysis

1. **`buildApp` hub 风险** — [graph] callgraph risk MEDIUM，7 个 direct dependents。每次 composition 变更都要覆盖 `src/server.ts:main`、`scripts/generate-openapi.ts:renderOpenApiArtifact`、`test/app.test.ts`、`test/bootstrap.test.ts`、`test/stream-token-routes.test.ts` 及两个 test harness；采用一个 v2 composition 接入点控制扩散。
2. **v1/v2 兼容风险** — [inferred] 直接把当前 v1 改成 camelCase 会破坏已准备的前端模型、OpenAPI golden 和旧调试脚本。冻结 v1、独立 v2 是首要风险控制；不允许同一路径按 header 返回两种 shape。
3. **身份合并风险** — [verified] 当前账号以 Privy user ID 映射随机 LOOP UUID；不同登录方式是否合并由 Privy account linking 决定。后端不得按 email、wallet address 或 alias 猜测合并；D1 之前必须冻结 dashboard linking policy。
4. **LOOP ID/Alias 隐私风险** — [verified] 当前 public alias 可重复且可变，group alias 群内唯一且永久不变；新版 loopId 需要独立唯一性/变更/删除规则。不能把 stable Stream ID 暴露来解决重名。
5. **Community/Stream 双系统风险** — [inferred] Community role/membership 与 Stream membership/projection 需要明确补偿和审计。Provider 不一致时不能让客户端按钮隐藏替代服务端授权。
6. **Stream 大群风险** — [verified] 单 channel 200,000 成员仍是书面 Provider Go/No-Go；失败时用分区/topic channels + app directory，不自建 IM（`docs/product-decisions.md`）。
7. **BSC Indexer/reorg 风险** — [inferred] Market、Wallet、Launch、Mining 共用 Asset/chain facts；若无 finality/reorg 先做上层，会造成四个模块返工和错误资金状态。D10 是后续关键路径。
8. **金额与签名风险** — [verified] repo 禁止 JS number 处理资金；新版还要求 atomic integer、digest、expiry、immutable review 和 unknown reconciliation。所有 Provider payload 必须由 server allowlist/adapter 生成，不能接受任意 calldata/to/URL。
9. **Privy Swap BSC 可测性风险** — [assumed] 当前产品要求 BSC，但可用测试环境/钱包类型/Flutter path 需要单独 POC；若只有 Mainnet capability，必须先有编号安全决策和小额 allowlist canary，不能因排期直接开启 Mainnet。
10. **Launch/Mining 外部阻塞** — [verified] 合约 ABI/地址/事件/审计、USD1/V3 地址、销售参数、Mining 公式/预算均未冻结。D18/D19 的时间区间不能转化为确定交付日期。
11. **迁移与数据删除风险** — [verified] migrations append-only；现有 group alias、profile code、friend graph 和 operation ID 不能因 v2 回滚被删除或重映射。v2 应用新表/投影或兼容 mapper。
12. **性能与成本** — [inferred] Community 聚合、全局搜索、行情、holders、未读和推荐不能在一个 request 内无界 fan-out。每个区域需 deadline、bulk read、缓存 TTL、partial response 和 provider budget。
13. **工作树风险** — [verified] 计划时存在用户自有 `AGENTS.md` unstaged 修改和 `.claude/`、`CLAUDE.md` untracked 内容；实施和提交必须继续排除这些无关文件。

## 10. Files Expected to Change

| File | Source-verified symbols | Reason |
| --- | --- | --- |
| `docs/decisions/0026-v2-bsc-product-baseline.md` | N/A | 冻结新版范围、版本和安全边界 |
| `docs/api-v2-conventions.md` | N/A | 统一 wire、error、idempotency、event contract |
| `openapi/loop-api.v2.json` | N/A | v2 generated contract；v1 artifact 保持 |
| `src/app.ts` | `buildApp` | 接入单一 versioned v2 composition |
| `src/config.ts` | `loadConfig` | 增加分模块 fail-closed 配置 |
| `src/database/database.ts` | `createPostgresDatabase` | 组合新领域 repositories/readiness |
| `scripts/generate-openapi.ts` | `renderOpenApiArtifact` | 双版本 deterministic OpenAPI |
| `src/routes/v2/**` | N/A（新文件） | v2 route schema、camelCase mapper、strict guards |
| `src/features/{session,community,social,search,assets,market,wallet,swap,launch,mining,notifications,security}/**` | N/A（新文件） | 领域 contract/service/policy；每模块单独计划 |
| `src/integrations/{privy,stream,bsc,market-data,security,push}/**` | N/A（新增或扩展） | 窄 Provider adapter；success/failure/freshness/abort |
| `src/database/*-repository.ts` | N/A（新模块 symbol 在实施时命名） | v2 persistence；业务规则留在 features |
| `migrations/000014_*` onward | `up`/`down` pattern 已由 `000013` 验证 | append-only module migrations |
| `src/indexer-worker.ts`, worker/domain files, Docker target | N/A（新文件） | 独立 BSC indexer runtime，不把重组逻辑塞入 API request |
| `test/v2-*.test.ts`, `test/*-repository.integration.test.ts` | N/A（新文件） | 每模块 contract/repository/behavior gates |
| `test/openapi.test.ts` | current OpenAPI test cases | v1 freeze + v2 exact artifact |
| `README.md`, `docs/frontend-*.md`, `docs/local-development.md` | N/A | 每次 G3 更新前端 handoff/runbook，不宣称未验证 Provider |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: >-
    Evolve loop-api-spot into a versioned LOOP V2 BSC backend through 21 small,
    independently deployable modules. Keep one frontend integration lane active,
    freeze v1, and begin with D0 contract/version plus D1 login/registration.
  acceptance_criteria:
    - Every module has frozen semantics, OpenAPI, implementation, tests, Development deployment, handoff pack, and physical-device/provider evidence where applicable.
    - The first formal handoff is D0+D1; registration is first Privy bootstrap, not a custom password system.
    - Home means Community home; no Home tab is reintroduced.
    - Hyperliquid/Perp/old orderbook Spot are not extended for V2.
    - V2 public DTOs/errors/events are camelCase and use opaque stable IDs and decimal-safe/atomic string values.
    - loop-mobile is not edited by backend work.
  external_inputs:
    - path: /Users/mac/Downloads/03-非合约产品方案.md
      sha256: 825bf74eabfee1182a8e33664ee8d71be0a6a777ff716eba2c676fc95f64ef5b
      role: 2026-09-01 authoritative non-contract product scope supplied by the user
  evidence_provenance:
    schema_version: 2
    head_commit: 142c7541f71c0a23aee4a6c216cab58a5fcb4dfe
    generated_plan_path: docs/plans/2026-09-01-gitnexus-plan-v2-module-delivery-roadmap.md
    global_dirty_digest:
      algorithm: sha256
      canonicalization: gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records
      value: 5c72bb6f8c4e2741e4ee3a24ffddb702dbe6db1aee13981fd69d13053c458197
    cited_path_manifest:
      - path: AGENTS.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: unstaged
        rename_from: null
        rename_to: null
        head_digest: sha256:f4a3d228effae9cef3d2ec7c55a51cec1d4fa5b4d9ee2de7a0a713ef413e34df
        index_digest: sha256:f4a3d228effae9cef3d2ec7c55a51cec1d4fa5b4d9ee2de7a0a713ef413e34df
        worktree_digest: sha256:05644bac5bd2c8f3ba5ba4aab2b882c15f6e3f70662fd77935651c9a447d2ec4
        untracked_digest: absent
      - path: README.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:0cca80aefaf2964c044da56282511c4d2aae69b7700a7f35e88ca3cbcfe0c393
        index_digest: sha256:0cca80aefaf2964c044da56282511c4d2aae69b7700a7f35e88ca3cbcfe0c393
        worktree_digest: sha256:0cca80aefaf2964c044da56282511c4d2aae69b7700a7f35e88ca3cbcfe0c393
        untracked_digest: absent
      - path: docs/decisions/0009-personalization-alerts-api.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:d3f2dcbb4d47cc05353917a37409fb0e4a543a08a5682eaf880ee6877b741d1f
        index_digest: sha256:d3f2dcbb4d47cc05353917a37409fb0e4a543a08a5682eaf880ee6877b741d1f
        worktree_digest: sha256:d3f2dcbb4d47cc05353917a37409fb0e4a543a08a5682eaf880ee6877b741d1f
        untracked_digest: absent
      - path: docs/decisions/0020-spot-write-start-admission-and-freeze.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:f0f0d8054889dd34b324c754260cca54bb39ca7679225fd71f5c077dae148957
        index_digest: sha256:f0f0d8054889dd34b324c754260cca54bb39ca7679225fd71f5c077dae148957
        worktree_digest: sha256:f0f0d8054889dd34b324c754260cca54bb39ca7679225fd71f5c077dae148957
        untracked_digest: absent
      - path: docs/decisions/0021-official-stream-token-issuer.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:88b2bb01fb1cccf87ad96139e6c66466cab8f882e4e7865d509bf86a2aa74003
        index_digest: sha256:88b2bb01fb1cccf87ad96139e6c66466cab8f882e4e7865d509bf86a2aa74003
        worktree_digest: sha256:88b2bb01fb1cccf87ad96139e6c66466cab8f882e4e7865d509bf86a2aa74003
        untracked_digest: absent
      - path: docs/decisions/0023-identity-stream-credential-smoke.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:9e5ab7fea723ff2c1d546d3332710f9777b8f2b1778d41cba5ed12c5a494cfb9
        index_digest: sha256:9e5ab7fea723ff2c1d546d3332710f9777b8f2b1778d41cba5ed12c5a494cfb9
        worktree_digest: sha256:9e5ab7fea723ff2c1d546d3332710f9777b8f2b1778d41cba5ed12c5a494cfb9
        untracked_digest: absent
      - path: docs/decisions/0024-alias-discovery-and-group-personas.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:2f1e3d38494d5d6884d266f3154dd5fdc40137e60fc1565a11d9b624f75f11c6
        index_digest: sha256:2f1e3d38494d5d6884d266f3154dd5fdc40137e60fc1565a11d9b624f75f11c6
        worktree_digest: sha256:2f1e3d38494d5d6884d266f3154dd5fdc40137e60fc1565a11d9b624f75f11c6
        untracked_digest: absent
      - path: docs/decisions/0025-friend-graph-and-backend-created-stream-channels.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:8d5544da457c0bd87cbf52cfe5a7150c99c735466a15b38b621f10f162bd7a0d
        index_digest: sha256:8d5544da457c0bd87cbf52cfe5a7150c99c735466a15b38b621f10f162bd7a0d
        worktree_digest: sha256:8d5544da457c0bd87cbf52cfe5a7150c99c735466a15b38b621f10f162bd7a0d
        untracked_digest: absent
      - path: docs/product-decisions.md
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:303037999b370f6ae8c8329e04a685a426ce1b2f3e0d249df29387b74c7fa70f
        index_digest: sha256:303037999b370f6ae8c8329e04a685a426ce1b2f3e0d249df29387b74c7fa70f
        worktree_digest: sha256:303037999b370f6ae8c8329e04a685a426ce1b2f3e0d249df29387b74c7fa70f
        untracked_digest: absent
      - path: migrations/000013_social_chat_closed_loop.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:6c81894476a904540373cf677a0a384f45d1ff8f664fef0e829d80853deece2e
        index_digest: sha256:6c81894476a904540373cf677a0a384f45d1ff8f664fef0e829d80853deece2e
        worktree_digest: sha256:6c81894476a904540373cf677a0a384f45d1ff8f664fef0e829d80853deece2e
        untracked_digest: absent
      - path: openapi/loop-api.v1.json
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:e0e8accdf2ac161f1c2f0bc2b02d95e467028e8c1e2356dc5f37783fd018f2e1
        index_digest: sha256:e0e8accdf2ac161f1c2f0bc2b02d95e467028e8c1e2356dc5f37783fd018f2e1
        worktree_digest: sha256:e0e8accdf2ac161f1c2f0bc2b02d95e467028e8c1e2356dc5f37783fd018f2e1
        untracked_digest: absent
      - path: package.json
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:0fd1288ee9a19e2e236a7685c03cb4492e65ad297a285715fe1b195e62c750dc
        index_digest: sha256:0fd1288ee9a19e2e236a7685c03cb4492e65ad297a285715fe1b195e62c750dc
        worktree_digest: sha256:0fd1288ee9a19e2e236a7685c03cb4492e65ad297a285715fe1b195e62c750dc
        untracked_digest: absent
      - path: scripts/generate-openapi.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:6cf698f91cafea5912cacbd91016fd85310da82db088e5f509bf2f5064bfb214
        index_digest: sha256:6cf698f91cafea5912cacbd91016fd85310da82db088e5f509bf2f5064bfb214
        worktree_digest: sha256:6cf698f91cafea5912cacbd91016fd85310da82db088e5f509bf2f5064bfb214
        untracked_digest: absent
      - path: scripts/identity-stream-smoke.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:cbc64202ee7fc2dd10d3fdb76472fb045ce7210dfe87487a630d1ab994e728fb
        index_digest: sha256:cbc64202ee7fc2dd10d3fdb76472fb045ce7210dfe87487a630d1ab994e728fb
        worktree_digest: sha256:cbc64202ee7fc2dd10d3fdb76472fb045ce7210dfe87487a630d1ab994e728fb
        untracked_digest: absent
      - path: src/app.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:63b8da0cad5bf9bde2d1f8de5e7e8e2da47c21525c84dc933fd5a65b885062df
        index_digest: sha256:63b8da0cad5bf9bde2d1f8de5e7e8e2da47c21525c84dc933fd5a65b885062df
        worktree_digest: sha256:63b8da0cad5bf9bde2d1f8de5e7e8e2da47c21525c84dc933fd5a65b885062df
        untracked_digest: absent
      - path: src/config.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:26648cf1d0b55140f26c0a3c37c89629d1d87900a1dbcbbfbbe20e30dc29856a
        index_digest: sha256:26648cf1d0b55140f26c0a3c37c89629d1d87900a1dbcbbfbbe20e30dc29856a
        worktree_digest: sha256:26648cf1d0b55140f26c0a3c37c89629d1d87900a1dbcbbfbbe20e30dc29856a
        untracked_digest: absent
      - path: src/core/http/authentication.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:69d8980e65d5db401f066ef90d1f3029c1712176f468d00877d1f71fe3107903
        index_digest: sha256:69d8980e65d5db401f066ef90d1f3029c1712176f468d00877d1f71fe3107903
        worktree_digest: sha256:69d8980e65d5db401f066ef90d1f3029c1712176f468d00877d1f71fe3107903
        untracked_digest: absent
      - path: src/database/database.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:99eecb3b1db1835b1bdd8da0ecb85b1a7a11748170e88c647902edac90a54344
        index_digest: sha256:99eecb3b1db1835b1bdd8da0ecb85b1a7a11748170e88c647902edac90a54344
        worktree_digest: sha256:99eecb3b1db1835b1bdd8da0ecb85b1a7a11748170e88c647902edac90a54344
        untracked_digest: absent
      - path: src/features/communication/stream-token-service.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:4b32fbac620ce3b5a6075a83aa63849824813626f0e9055b79f477bdffb59a13
        index_digest: sha256:4b32fbac620ce3b5a6075a83aa63849824813626f0e9055b79f477bdffb59a13
        worktree_digest: sha256:4b32fbac620ce3b5a6075a83aa63849824813626f0e9055b79f477bdffb59a13
        untracked_digest: absent
      - path: src/features/identity/bootstrap-service.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:874db6afb90117d5496ec36167ad0cdc27a6c877863721b3814da211364546d8
        index_digest: sha256:874db6afb90117d5496ec36167ad0cdc27a6c877863721b3814da211364546d8
        worktree_digest: sha256:874db6afb90117d5496ec36167ad0cdc27a6c877863721b3814da211364546d8
        untracked_digest: absent
      - path: src/routes/bootstrap.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:78c8e51fc509223432ee4a4afd552350004a8351ed3c13bb4e24188acdf932ee
        index_digest: sha256:78c8e51fc509223432ee4a4afd552350004a8351ed3c13bb4e24188acdf932ee
        worktree_digest: sha256:78c8e51fc509223432ee4a4afd552350004a8351ed3c13bb4e24188acdf932ee
        untracked_digest: absent
      - path: src/routes/chat-channels.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:d9d5fbf0cc8a3ccba3cf3bc1ae783622153e6b97420c66ac8d1b2e6df6f7cc20
        index_digest: sha256:d9d5fbf0cc8a3ccba3cf3bc1ae783622153e6b97420c66ac8d1b2e6df6f7cc20
        worktree_digest: sha256:d9d5fbf0cc8a3ccba3cf3bc1ae783622153e6b97420c66ac8d1b2e6df6f7cc20
        untracked_digest: absent
      - path: src/routes/discovery.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:0df159b4f4402b11aabdc3880c1696239ccfd32bddf07296daf6c38efb8d6b6b
        index_digest: sha256:0df159b4f4402b11aabdc3880c1696239ccfd32bddf07296daf6c38efb8d6b6b
        worktree_digest: sha256:0df159b4f4402b11aabdc3880c1696239ccfd32bddf07296daf6c38efb8d6b6b
        untracked_digest: absent
      - path: src/routes/profile.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:3e2835b7f4572d694de92b16eee38db9b75b23111041e02e50dec3358cec3b88
        index_digest: sha256:3e2835b7f4572d694de92b16eee38db9b75b23111041e02e50dec3358cec3b88
        worktree_digest: sha256:3e2835b7f4572d694de92b16eee38db9b75b23111041e02e50dec3358cec3b88
        untracked_digest: absent
      - path: src/routes/social.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:2e2f3c01e6f336e756be41e57b4be46bf2d5a88b2341f55f3fb84688f3665b26
        index_digest: sha256:2e2f3c01e6f336e756be41e57b4be46bf2d5a88b2341f55f3fb84688f3665b26
        worktree_digest: sha256:2e2f3c01e6f336e756be41e57b4be46bf2d5a88b2341f55f3fb84688f3665b26
        untracked_digest: absent
      - path: src/routes/stream-tokens.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:f951f02b3e9091a821b9771ff95dca319877c575b4cfe9dbd48c2fb388c4e80d
        index_digest: sha256:f951f02b3e9091a821b9771ff95dca319877c575b4cfe9dbd48c2fb388c4e80d
        worktree_digest: sha256:f951f02b3e9091a821b9771ff95dca319877c575b4cfe9dbd48c2fb388c4e80d
        untracked_digest: absent
      - path: test/bootstrap.test.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:650d24f451bda82d5d0cbb20e91434e4488e033615b401d7a983b6a3db921480
        index_digest: sha256:650d24f451bda82d5d0cbb20e91434e4488e033615b401d7a983b6a3db921480
        worktree_digest: sha256:650d24f451bda82d5d0cbb20e91434e4488e033615b401d7a983b6a3db921480
        untracked_digest: absent
      - path: test/chat-channel-routes.test.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:8d9b41aa7c926b9304508e5d55324640c8dfc584ee79de347cd29da67dadbcf0
        index_digest: sha256:8d9b41aa7c926b9304508e5d55324640c8dfc584ee79de347cd29da67dadbcf0
        worktree_digest: sha256:8d9b41aa7c926b9304508e5d55324640c8dfc584ee79de347cd29da67dadbcf0
        untracked_digest: absent
      - path: test/identity-stream-smoke.test.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:4ac7877d518b51e6d00041a0fb0506f717b1134a78f045f31ea5015439a6e243
        index_digest: sha256:4ac7877d518b51e6d00041a0fb0506f717b1134a78f045f31ea5015439a6e243
        worktree_digest: sha256:4ac7877d518b51e6d00041a0fb0506f717b1134a78f045f31ea5015439a6e243
        untracked_digest: absent
      - path: test/openapi.test.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:60406d0739a2ea6815972edf223da84f24dc391567a811612af7301243f93973
        index_digest: sha256:60406d0739a2ea6815972edf223da84f24dc391567a811612af7301243f93973
        worktree_digest: sha256:60406d0739a2ea6815972edf223da84f24dc391567a811612af7301243f93973
        untracked_digest: absent
      - path: test/social-routes.test.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:17dc298ca9382539f6981a6aaf439656ccfbc79b10c14cb05286a4cdae8c689a
        index_digest: sha256:17dc298ca9382539f6981a6aaf439656ccfbc79b10c14cb05286a4cdae8c689a
        worktree_digest: sha256:17dc298ca9382539f6981a6aaf439656ccfbc79b10c14cb05286a4cdae8c689a
        untracked_digest: absent
      - path: test/stream-token-routes.test.ts
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: clean
        rename_from: null
        rename_to: null
        head_digest: sha256:dac43260521f44e47e805d03de78d9277f22367474216fd89e583f9c31771d31
        index_digest: sha256:dac43260521f44e47e805d03de78d9277f22367474216fd89e583f9c31771d31
        worktree_digest: sha256:dac43260521f44e47e805d03de78d9277f22367474216fd89e583f9c31771d31
        untracked_digest: absent
  primary_symbols:
    - symbol: buildApp
      file: src/app.ts
      lines: 272-783
      role: HTTP/provider/database composition and route/OpenAPI registration hub
    - symbol: loadConfig
      file: src/config.ts
      lines: 290-422
      role: fail-closed environment parsing and module capability selection
    - symbol: createPostgresDatabase
      file: src/database/database.ts
      lines: 96-236
      role: repository composition and readiness ownership
    - symbol: registerBootstrapRoute
      file: src/routes/bootstrap.ts
      lines: 13-72
      role: existing Privy-to-LOOP registration/bootstrap boundary
    - symbol: registerStreamTokenRoutes
      file: src/routes/stream-tokens.ts
      lines: 106-113
      role: existing Chat/Video token boundary
  related_symbols:
    - symbol: registerSocialRoutes
      relationship: called-by buildApp; tested-by test/social-routes.test.ts
      relevance: reusable consent/idempotency/cursor patterns
    - symbol: registerChatChannelRoutes
      relationship: called-by buildApp; tested-by test/chat-channel-routes.test.ts
      relevance: reusable provider-operation polling/reconciliation
    - symbol: registerProfileRoutes
      relationship: called-by buildApp
      relevance: reusable owner-bound CAS resources
    - symbol: registerDiscoveryRoutes
      relationship: called-by buildApp
      relevance: reusable bounded privacy-preserving search
    - symbol: renderOpenApiArtifact
      relationship: calls buildApp
      relevance: deterministic API contract golden
  execution_path:
    - Mobile authenticates with Privy and obtains a current access token.
    - BFF validates that token on every protected request and maps the Privy subject to an opaque LOOP account.
    - Bootstrap creates/reuses the account and derives Stream identity server-side.
    - Feature routes accept no client-selected owner/provider subject; services enforce policy and repositories persist state.
    - Provider operations use bounded adapters, durable idempotency/attempt records, and polling/reconciliation for unknown outcomes.
    - Route schemas generate committed OpenAPI artifacts and Development deployment is handed to Flutter only after module gates pass.
  pdg_constraints:
    - description: buildApp whole-symbol PDG seed has no local affected statement list; interprocedural bridge reports 11 dependents and UNKNOWN PDG risk.
      affected_statements: []
      implementation_consequence: Use source ordering plus callgraph impact; keep one v2 composition entry and rerun line-anchored PDG for each concrete edit.
    - description: Stream issuance ordering reserves persistent quota before issuer work and checks abort at each boundary.
      affected_statements:
        - src/features/communication/stream-token-service.ts:269
      implementation_consequence: V2 may remap DTOs only; it must not reorder quota, cache tokens, or broaden token claims.
  architectural_patterns:
    - pattern: Strict route schema plus pre-auth input guard
      example_location: src/routes/bootstrap.ts:registerBootstrapRoute
      usage_guidance: Reject body/query/header expansion before authentication or provider/database work.
    - pattern: Owner-bound CAS replacement
      example_location: src/routes/profile.ts:registerProfileRoutes
      usage_guidance: Keep expectedVersion for concurrency and add v2 UUID idempotency only in the versioned contract.
    - pattern: Durable command operation with polling/reconciliation
      example_location: src/routes/chat-channels.ts:registerChatChannelRoutes
      usage_guidance: Use for every write whose provider result can be lost or ambiguous.
    - pattern: Provider unavailable adapter
      example_location: src/app.ts:buildApp
      usage_guidance: Missing or unverified dependencies select a sanitized fail-closed service, never fixture success.
    - pattern: Deterministic generated OpenAPI
      example_location: scripts/generate-openapi.ts:renderOpenApiArtifact
      usage_guidance: Route schema is source; update golden once at module completion.
  files_to_modify:
    - file: docs/decisions/0026-v2-bsc-product-baseline.md
      symbols: []
      intended_change: Freeze V2 scope, versioning, BSC and provider boundaries before behavior changes.
    - file: src/app.ts
      symbols: [buildApp]
      intended_change: Add one versioned V2 composition boundary while preserving V1.
    - file: src/config.ts
      symbols: [loadConfig]
      intended_change: Add fail-closed per-module V2/provider configuration over successive modules.
    - file: src/database/database.ts
      symbols: [createPostgresDatabase]
      intended_change: Compose append-only repositories and readiness relations module by module.
    - file: scripts/generate-openapi.ts
      symbols: [renderOpenApiArtifact]
      intended_change: Generate/check independent V1 and V2 artifacts.
    - file: src/routes/v2/**
      symbols: []
      intended_change: New versioned public routes; exact symbols are chosen and source-verified in each module plan.
    - file: src/features/**
      symbols: []
      intended_change: New Community/BSC/Wallet/Swap/Launch/Mining/Notification domain slices.
    - file: src/integrations/**
      symbols: []
      intended_change: Narrow Privy/Stream/BSC/market/push provider adapters.
    - file: migrations/000014_* onward
      symbols: []
      intended_change: Append-only V2 domain persistence.
  tests:
    - file: test/openapi.test.ts
      scenarios:
        - Existing V1 artifact remains byte-stable while V2 is added.
        - V2 artifact is deterministic and contains only approved module operations.
    - file: test/v2-session-routes.test.ts
      scenarios:
        - First valid Privy token → opaque account/session; replay → same account.
        - Invalid/expired token or client-selected identity → sanitized rejection without persistence.
    - file: test/v2-community-home-routes.test.ts
      scenarios:
        - Real joined/recommended projection → stable destinations; unavailable subprovider → partial/unavailable, never fixture data.
    - file: test/v2-swap-intent-routes.test.ts
      scenarios:
        - Quote/digest/expiry/active-wallet facts → immutable intent; changed fact → stale intent; unknown submit → no replay and polling.
    - file: test/bsc-indexer-reorg.integration.test.ts
      scenarios:
        - Duplicate/removed/replacement logs → deterministic projection rollback and rebuild.
  verification_commands:
    - pnpm install --frozen-lockfile
    - pnpm secrets:check
    - pnpm test:contract
    - pnpm test:integration
    - pnpm test:worker
    - pnpm check
    - pnpm docker:build:migration
    - pnpm docker:build:runtime
    - pnpm docker:build:worker
    - docker compose config --quiet
    - pnpm stream:verify
    - pnpm identity-stream:smoke
  risks:
    - V1/V2 wire drift and duplicate business logic.
    - Privy account-linking ambiguity across Email/Apple/Google/external wallet.
    - Community/PostgreSQL roles diverging from Stream membership/permissions.
    - BSC confirmation/reorg errors contaminating Wallet, Launch and Mining.
    - Privy Swap lacking a suitable BSC Development/test path.
    - Launch contracts and Mining formula remaining externally unapproved.
    - User-owned dirty AGENTS.md/.claude/CLAUDE.md being accidentally committed.
  assumptions:
    - Check that the user accepts V1 freeze plus V2 public contract by recording Decision 0026 before D1 implementation.
    - Check Privy account-linking policy in the dashboard and prove all four login methods on physical devices before D1 G4.
    - Check LOOP ID format, permanence, rename and deletion policy before D2 schema/migration.
    - Check Stream commercial limits and client permission matrix before Community/Chat G4.
    - Check BSC RPC/Indexer providers, official USD1 address and Pancake V3 dependencies before D10/D18.
    - Check Privy BSC Swap capability and safe test/canary environment before D15.
    - Check Launch ABI/events/audit and Mining formula/budget before D18/D19.
  open_questions:
    - Should a user-selected LOOP ID be immutable forever, renameable with cooldown, or server-generated?
    - Does V2 require follow/follower in the first social slice, or only accepted friends plus block/unfriend/DM requests?
    - What object storage and moderation service owns profile/community/Launch media?
    - What system authenticates Admin users and enforces four-eyes approval?
    - Which BSC RPC, Indexer, market-data, security, push and Bridge providers are selected?
    - If Privy Swap supports BSC only on Mainnet, is a numbered small-value canary decision acceptable?
  avoid:
    - Do not edit loop-mobile from backend tasks.
    - Do not restore a Home tab; Community is the post-login home.
    - Do not extend Hyperliquid/Perp or reuse their public routes for BSC V2.
    - Do not change V1 wire shapes while V2 is introduced.
    - Do not expose Privy, internal LOOP, Stream, wallet authority, secrets, raw provider payloads or arbitrary calldata.
    - Do not use fixture values as provider, chain, balance, price, membership or transaction facts.
    - Do not implement Launch pre-graduation sell/redemption or auto-convert a Launch intent into Swap.
    - Do not claim a module complete before G4 evidence.
    - Do not include user-owned AGENTS.md, .claude/, or CLAUDE.md changes in implementation commits.
    - Do not repeat full repository discovery; start each module from this pack and perform only scoped drift/impact checks.
```

## 12. Assumptions and Open Questions

### Recommended defaults to record in D0

1. [assumed] **API version**：采用 `/v2`，冻结 `/v1`。若用户明确选择破坏 v1，排期可缩短约 1–2 周，但现有前端/脚本会一起迁移，风险更高；不推荐。
2. [assumed] **认证**：所有受保护 API 继续逐请求校验 Privy access token；`sessionId` 是设备/审计/撤销投影，不自建长效登录 token。
3. [assumed] **注册**：没有独立密码注册；Privy 首次认证后的 idempotent session bootstrap 创建 LOOP account。
4. [assumed] **写幂等**：v2 所有 write 需要 UUIDv4；CAS write 同时需要 `expectedVersion`，两者职责不同。
5. [assumed] **Community**：PostgreSQL 是 Community/role/audit 真相源，Stream 是 communication state 真相源；同步未知时通信关闭。
6. [assumed] **BSC 环境**：在没有安全决策前只做 read-only；任何 Mainnet 签名/广播保持关闭。
7. [assumed] **开发节奏**：前端一次只联调一个 G3 模块；后端底层研究可并行但不提前承诺公共 shape。

### 必须在对应模块前回答

- D1：Privy 的 Email/Apple/Google/external wallet account linking、MFA、session revoke 到底按什么规则？验证同一用户跨方法是否应该合并。
- D2：LOOP ID 格式、大小写、保留词、敏感词、是否可改、删除后能否复用；avatar storage/审核 Provider。
- D5/D7：Community 单群与用户小群是否使用相同 Stream App/channel type；200k member 书面上限和权限矩阵。
- D6：一期是否必须包含 follow/follower，还是先完成 friend + unfriend + block + DM requests。
- D10/D11：BSC RPC/Indexer、market/Kline、security facts 的 Provider、许可、TTL 和成本。
- D14：Firebase project/APNs、push provider 名称、数据保留和 mandatory notification policy。
- D15：Privy BSC Swap 支持的钱包类型、网络和 test/canary 方式；平台费和 hard slippage policy。
- D17/D18：Admin identity、object storage、Launch ABI/address/events/audit、USD1 与 Pancake V3 正式配置。
- D19：Mining asset scope、price source、formula、rounding、caps、reward budget/claim authority 和反作弊规则。
- D20/D21：recovery/key export、Bridge、Pay、DApp、AI 是否有 Provider 和合规批准；没有则继续 unavailable。

明确延后：生产 Mainnet 发布、Bridge、Pay 执行、DApp Browser、Community AI、smart-money 和交易所里程碑自动化都需要独立计划，不能借本路线图默认授权。

## 13. Definition of Done

### 单模块完成

一个模块只有同时满足以下条件才标为 G4/完成：

- 业务实体、stable ID、权限、状态机、来源/freshness、错误和 unavailable 行为已写入决策；
- v2 OpenAPI/DTO/error/示例冻结且 artifact 无漂移，v1 未被破坏；
- migration/repository/service/adapter/route 已实现，缺依赖 fail closed；
- unit、route、contract、database integration、security 和 full regression 全绿；
- Development 部署 ready，日志/metric/audit/alert 能定位问题且无 secret/PII 泄漏；
- 需要 Provider 的模块有 credentialed sandbox/testnet/canary 证据；需要原生 SDK 的模块有实体手机证据；
- 标准交付包已给前端，正向、负向、超时、离线、重连和恢复测试通过；
- rollback/runbook 和 known unavailable 清单完整。

### 整体完成

- D0–D20 中属于一期的模块全部至少 G4；D21 明确保留 unavailable，不出现 fake success。
- 93 页面所需的每一项数据/动作都能映射到真实 API/Stream/Privy/Indexer/合约来源或明确 unavailable 状态。
- 普通 Token 只走 Privy Swap；未毕业 Launch 只购买不卖，不复用 Swap intent；Hyperliquid/Perp 不进入新版客户端。
- BSC chain/asset/pool/wallet/transaction 使用 canonical IDs，确认/reorg 能恢复；资金写入只有一次 provider attempt，unknown 通过 polling/reconciliation 解析。
- 全部 Provider、合规、安全、Admin RBAC、备份、灾备、监控和发布回滚证据通过后，才从 G4 提升 G5。

### 下一步

立即执行 D0，然后把 D0+D1 作为第一个交付批次。D0 不需要新的 Provider secret；D1 使用现有 Privy/Stream 配置，前端仅需在真机生成当前 Privy access token并自行通过安全的 stdin smoke/应用请求完成验收，不能把 token 粘贴到聊天。
