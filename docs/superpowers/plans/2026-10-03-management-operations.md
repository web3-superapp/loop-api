# LOOP 管理与人工运营 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 建立有权限、可审计、真实持久化的运营工作台，优先修复和贯通挖矿配置及已有人工服务，再补管理功能。
**Architecture:** 沿用 Fastify、Privy 和 PostgreSQL；独立 ops 命名空间，按操作员授权读取和写入。Web 无新增框架依赖，通过同源 API 使用当前 Privy Token；所有未接消费链路的配置只列清单不伪装为可执行。
**Tech Stack:** Node 24、TypeScript、Fastify 5、pg、Zod、原生 HTML/CSS/JS；移动端 Flutter。

## Task 1: 挖矿权重历史隔离

Files: src/database/mining-repository.ts, migrations/000046_ops_mining_weights.ts, src/database/schema.ts, test/mining-*.test.ts。

- [x] 先写版本 A/B 权重隔离测试，确认旧存储覆写问题。
- [x] 新 migration 改为 config_version+community_id 唯一；保留可证明旧关联，禁止批准版本原地改权重。
- [x] 读取旧快照/指定版本，不产生跨版本 fallback。
- [x] pnpm exec vitest run test/mining-repository.integration.test.ts（隔离 test DB），验证两版输入及原有校验。

## Task 2: 运营持久化与权限

Files: src/features/ops/ops-contract.ts, src/database/ops-repository.ts, migrations/000047_ops_control_plane.ts + 000048_ops_mining_jobs.ts, test/ops*.test.ts。

- [x] 新表 operators/grants、config drafts、operation ledger；权限默认拒绝，无公开管理员注册。
- [x] 稳定 UUID operationId 绑定 actor/action/target/request hash，锁定授权、并发检查、审计和业务写入同事务。
- [x] 配置包包含 formula、communityWeights、pricing；编辑者不可批准自身，审批发布检查 active version + hash。
- [x] 测试匿名、普通用户、撤权、越权、并发、hash 冲突、幂等重放和自审批。

- [x] 失败/未知结果审计用独立 audit 表在业务事务回滚后记录脱敏原因；operation ledger 查询仅对应操作者或同范围审计员可读，不泄露请求内容。
- [x] 持久化 ops_jobs 和事务内入队，执行器只处理允许动作；人工执行时事务行锁 claim（不另设后台 lease）、去重键、重试上限、执行前撤权与版本检查，撤权进入 held。
- [x] mining draft 修订 CAS、重新提交和 hash 失效测试；试算保存原区块/价格版本/input hash，复用 mining-snapshot 引擎；快照生成使用现有 runner 抽取的服务，不执行 shell。
- [x] 历史输入不可证明时查询返回 historyReproducibility=legacy_unknown，不新增推断权重；测试缺失版本关联。

## Task 3: 管理 HTTP 和真实消费

Files: src/routes/ops.ts, src/app.ts, src/database/database.ts, test/ops-routes.test.ts, openapi/loop-api.ops.json。

- [x] GET session/catalog/mining/communities/support/audit；所有敏感读写用既有 authenticateLoopBearer，再查 DB 授权。
- [x] POST /ops/api/commands 的 mining.create/revise/submit/publish、community.review、support.answer，严格 JSON schema，无客户端 actor。
- [x] GET /ops/api/operations/:id 与 /ops/api/jobs/:id 查询恢复；测试提交成功响应丢失、同 ID 重试只执行一次和越权读取拒绝。
- [x] 统一 commands 修订/试算/快照命令与 resources/snapshots 读取路由；公开可复算输入证据，不声称奖励已发放。
- [x] 数据库写入和通知入队同事务；队列执行前重新授权，撤权阻止执行，通知失败不重跑业务事务。
- [x] 工作台的配置必须写入既有业务表以供 App 读取；通知/provider 结果独立且不谎报成功。
- [x] pnpm typecheck / openapi:generate / openapi:check / test，确认生产不启用链上执行。

## Task 4: 独立 Web 工作台

Files: src/features/ops/web/{index.html,app.js,styles.css}, src/routes/ops-web.ts, test/ops-web.test.ts。

- [x] 黑白绿、固定侧栏、紧凑表格、详情侧板、明显当前版本和待审状态；小屏抽屉/纵向表单。
- [x] 同源访问；凭据仅内存，不写 storage/log/url；授权失败清空数据；不渲染未经转义 HTML。
- [x] 矿业表单、版本差异、审核理由、系数、审计记录；未知写入结果保留 operationId 供查询恢复。
- [x] 功能目录区分可操作/仅阅读/待契约，不生成空壳成功按钮。
- [x] 浏览器检验登录拒绝、键盘操作、窄屏及后端失败；预览数据单独入口，不和真实连接混用。

## Task 5: App 与后续模块

Files: mobile/lib/features/community/*, mobile/lib/features/chat/v2/group_screens.dart；逐模块另写细化步骤。

- [x] B1：先 GitNexus impact，集中既有管理入口；保留后端逐目标 actions。
- [ ] 普通群目录/资料/邀请/移除权限和 Stream 对账，新契约完成后才开放；不套社区权限。
- [ ] 逐项接项目/资产、白名单、推荐内容、客服策略/客户端策略/AI配额等；每项具备消费和测试再标记完成。
- [x] 合约只更新交接；未接通或外部依赖未验收项明确列出。

## Task 6: 完整验证与交接

- [x] pnpm format:check / lint / typecheck / openapi:check / test --maxWorkers=2（3,366 通过）/ build / docker compose config --quiet。
- [x] 独立测试库执行迁移和 integration suites；最终全量 538 通过/1 个新增测试类型错误，修正后运营 16/16 通过，详见交接。不读取或修改现有开发/生产库。
- [x] A 与 B1 规格评审后代码质量评审；修复 muted 管理员、CLI 审计归因和 API/撤权锁环后复审 Approved。
- [x] 更新 docs/handoff/2026-10-03-management-operations.md，分清实现/验证/未验证；分支提交，不合并。

## 当前交付切片

A1–A4 与 B1 提交为独立 Draft PR；B2–D 仍按以上未勾选项继续开发。App PR：web3-superapp/loop-mobile#6（叠加 #5）。这份清单不是“全部人工运营能力已上线”声明。
