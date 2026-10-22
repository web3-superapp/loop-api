# 0175 · 社区自定义标签：后台填写、替代前台「已验证」标识（S282，2026-10-22）

## 1. Status

已实现（分支 `feat/S282-community-label`，基线 `integration/v2` `220a30b`）。迁移 `000097_community_label`（只加一列；不依赖 000095 / 000096 之外的任何未合入迁移，号码若与并行批次冲突由主代理改号）。新路径 1 条：`PUT /admin/v1/communities/{communityId}/label`。新 env：`COMMUNITY_LABEL_EMIT`（默认 `off`）。配套：loop-admin `feat/S282-community-label`（社区详情「自定义标签」行、列表「标签」列）。App 侧（去掉「已验证」、改显示 `label`）待另派。

## 2. Context

- 需求方 2026-10-22 反馈第 02 条，答复：
  1. 后台审核**保留**，它只决定社区能否被搜到 / 是否公开（`verificationStatus` 的现有 gating 不变）。
  2. 前台「已验证」标识**全部去掉**，改为后台管理员给单个社区填一个自定义文字标签（暂定一个，任意文字，如「算力社区」「精选社区」「共识社区」），显示在原「已验证」出现的所有位置。
- 已发布 App 的 V2 解码器严格（10-19 S239 教训，决策 0166 §D）：既有响应对象新增键必须默认关闭。

## 3. Decision

### A. 实体与存储

- `communities.label text null`：每社区至多一个标签；null = 无标签（全部存量行）。主键仍是 opaque `communityId`，标签只是展示文本，不作任何关联键。
- 规则（应用层校验并规范化）：`trim` 后为空 = 清空（存 null）；长度 1–12 个字符（按 Unicode code point 计，与 JSON Schema `maxLength` 同口径）；超长拒绝。数据库 check `communities_label_check` 兜底（null，或 1–12 且等于 `btrim(label)`）。
- 与 `verification_status` 完全独立：设置 / 清空标签不改审核状态、不影响搜索 / 公开可见性；未通过审核的社区也可以先填标签（陌生人照样看不到它）。

### B. 后台接口 `PUT /admin/v1/communities/{communityId}/label`

- 鉴权同审核接口：控制台会话 + `console.write`（platform_admin）；`auditor` / `reviewer` / `testnet_acceptor` 403 `PERMISSION_DENIED`。无 `Idempotency-Key`（同审核接口；PUT 设值本身幂等）。
- 请求 `{ "label": string | null }`（`additionalProperties: false`，`label` 必填，字符串上限 256 防滥用，实际规则见 A）。
- 响应 200 `{ community: <控制台社区行，含 label>, changed: boolean, audit: {auditId, seq, at} | null }`，`Cache-Control: no-store`。
- 审计：值有变化时，在同一事务里（行锁 `for update`）写 `admin_audit_log` 一行 `community.label.update`，`targetType = community`，`before {label}` / `after {label}`；值未变 → `changed: false`、`audit: null`、不写任何行。
- 错误：`400 INVALID_REQUEST`（缺 `label`、多余字段、非字符串非 null）；`404 NOT_FOUND / ADMIN_COMMUNITY_NOT_FOUND`（非 UUID 或不存在）；`422 VALIDATION_FAILED / ADMIN_COMMUNITY_LABEL_TOO_LONG`（`detailsSafe.field = "label"`）；`503 CAPABILITY_UNAVAILABLE / ADMIN_DATABASE_UNAVAILABLE`（库不可用，fail closed）；会话类 401 / 403 同其他控制台写接口。
- 控制台社区行（列表、详情、审核响应、本接口响应）恒带 `label`（必有键，可为 null）。控制台是服务端到服务端，loop-admin 同批更新。

### C. /v2 公开输出（开关 `COMMUNITY_LABEL_EMIT`）

- 所有带社区 `verificationStatus` 的 /v2 投影新增**可选**键 `label: string | null`，紧随 `verificationStatus`：
  - 社区摘要 `CommunitySummary`（`GET /v2/communities`、`GET /v2/communities/{id}` 及全部命令响应的 `community`、`GET /v2/community/home` 的 `joined` / `owned` / `discover`、成员列表的 `community`、`GET /v2/communities/recommended` 的 `items`）；
  - `GET /v2/search` 的 `displaySnapshot.label`：社区结果为其标签，用户 / 资产结果恒为 `null`；
  - `GET /v2/profiles/{id}/communities` 的 `items[].label`（个人主页社区栏）。
- `COMMUNITY_LABEL_EMIT=off`（默认）：以上响应与之前**逐字节相同**（不带键）。`on`：每处都带键（无标签为 `null`）。schema 中不在 `required`，永远不改为必带。
- `verificationStatus` 原样输出，值与 gating 均不变。App 侧应改为：不再渲染「已验证」，在原位置渲染 `label`（非 null 时）。
- 不涉及：市场资产详情的 `community` 块（不带 `verificationStatus`）、控制台以外的 AI 知识事实、Launch 审核页。

### D. unavailable 行为

- 无新 Provider、无凭据；库不可用时控制台接口 503 fail closed，/v2 读取沿用各自现有的 unavailable 语义。不存在用 fixture 冒充的路径。

### E. 发布顺序

1. 上线服务端（迁移 000097；`COMMUNITY_LABEL_EMIT` 保持 `off`）与 loop-admin，运营即可开始填标签（前台暂不可见）。
2. App 在 codec 中加入可选键 `label`（并去掉「已验证」）发版。
3. 所有仍受支持的 App 版本都能解码后，再把 `COMMUNITY_LABEL_EMIT` 切到 `on`。

## 4. Consequences

- 存量社区无标签：开关打开后输出 `label: null`，App 什么都不显示（「已验证」已去掉）。
- 回滚：000097 `down` 直接删列（标签只是控制台数据，丢失可接受）。
- 证据：`test/admin-routes.test.ts`（设置 / trim / 未变不写审计 / 12 字边界 / 超长 422 / 清空 / 400 / 404 / 401）、`test/v2-community-routes.test.ts`（详情、列表、home、搜索社区 / 用户结果在 unset / off / on 下的输出）、`test/v2-public-profile-routes.test.ts`（推荐社区 off / on）、`test/v2-public-profile-launch2-routes.test.ts`（个人主页社区栏 off / on，off 时键集不变）、`test/config.test.ts`（开关解析）、`test/openapi.test.ts`（控制台路由清单）、`test/community-label.integration.test.ts`（真实 PostgreSQL：迁移与约束、写入 / 清空 / 审计、各 /v2 读取带标签且可见性不变）。
