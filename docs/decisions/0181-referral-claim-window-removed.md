# 0181 · 取消邀请码 7 天绑定窗口，改为永久可绑定（S298，2026-10-25）

## 1. Status

已实现（分支 `s298-referral-claim-window-removed`，基线 `integration/v2` `d1a32d9`）。**无迁移**、无新依赖、无新 env。改动 `openapi/loop-api.v2.json`（`/v2/referral*` 的描述、`deprecated` 标注、claim 去掉 403）与 `openapi/loop-web.v2.json`（`/v2/web/*` 去掉 `windowEndsAt`、claim 去掉 403）。`/v1` 不动。

修订：0036（邀请关系，§「7 天补绑窗口」）、0162（邀请中心）、0179（官网注册写面）、0180（官网「我的邀请」）。

## 2. Context

需求方 2026-10-25 要求：邀请码**永久可填**，不再限制「起名（激活 LOOP ID）后 7 天内」。

原规则（0036）：窗口 `[activatedAt, activatedAt + 7 天)`，超出后 `POST /v2/referral/claim` 返回 `403 POLICY_BLOCKED`（官网面 `detailsSafe.reasonCode = REFERRAL_CLAIM_WINDOW_CLOSED`），并写一条 `referral_claim_rejected`（`claim_window_closed`）事件。

## 3. Decision

### A. 服务端规则

- claim 不再看时间：去掉窗口判断、`POLICY_BLOCKED` 分支与 `claim_window_closed` 拒绝事件。App 面与 `/v2/web` 面都**永不再返回** `403 POLICY_BLOCKED` / `REFERRAL_CLAIM_WINDOW_CLOSED`；两面的 OpenAPI 都去掉了 claim 的 403。
- 其余检查与顺序不变：请求形状 → 已激活（否则 `409 PROFILE_ACTIVATION_REQUIRED`）→ 码存在（`404`，不可枚举）→ 非自邀 / 不成环（`422 VALIDATION_FAILED`）→ 一账号只绑一次（`409 DATA_STALE`）→ 一个事务内物化至多 5 级边；同一 `Idempotency-Key` 重放原结果。
- 历史 `referral_events` 里已有的 `claim_window_closed` 行保留（append-only），不再新增。
- `/i/{code}` 落地页文案「注册后 7 天内有效」改为「注册后随时可以绑定」。

### B. App 面 `/v2/referral` 兼容（客户端先行规则）

已发出的 App（build ≤ 42）codec（`loop_v2_referral_api.dart`）严格解码：`rules` 必须含正整数 `claimWindowDays`；`binding.claimWindow` 非 unavailable 时必须是 `{status: open|closed, activatedAt, closesAt}`，`closesAt` 必须是可解析的时间戳字符串。因此本批**键集与类型一律不变**：

| 键                                | 本批取值                                                                           | 说明                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `rules.claimWindowDays`           | 仍为整数 `7`                                                                       | OpenAPI 标 `deprecated`，不再执行；常量改名 `referralLegacyClaimWindowDays` 只作线格式 |
| `binding.claimWindow.status`      | 激活前 `unavailable`（`PROFILE_ACTIVATION_REQUIRED`，不变）；激活后**恒为 `open`** | `closed` 不再出现，enum 保留以免旧 codec 规则漂移                                      |
| `binding.claimWindow.activatedAt` | 激活时刻（不变）                                                                   |                                                                                        |
| `binding.claimWindow.closesAt`    | **固定哨兵 `"9999-12-31T23:59:59.999Z"`**                                          | OpenAPI 标 `deprecated`，schema 仍是必填 `date-time` 字符串                            |

`closesAt` 二选一的结论：**继续返回字符串、取固定远期哨兵**，不改成 nullable。理由：旧 codec 用 `requireTimestamp`，null 会抛错，nullable 只是文档上的变化、实际仍得发字符串；而若继续发 `activatedAt + 7 天`，build 42 会显示一个已经过去的「截止」时间却仍允许绑定，更误导。哨兵是常量（`referralClaimWindowNoDeadline`），与时钟无关，语义明确为「无截止」。build 42 在未绑定时会显示「本账号的绑定窗口截止 9999-12-31 …」这一行，可读作「永久」，loop-mobile 并行批次会把文案改成永久并不再读这两个键。

### C. 官网面 `/v2/web/*`（无已发版客户端约束）

0179 / 0180 刚上线、loop-web 尚未发布，直接改形态：**删除 `windowEndsAt` 键**。

- `POST /v2/web/session` → `invite: { bound, canClaim }`；`canClaim = 邀请模块可用 && 未绑定`。
- `GET /v2/web/referral/me` → `binding: { bound, canClaim }`；`canClaim = 未绑定`。
- 未起名时 `canClaim` 仍为 true（含义「起名后即可绑」）；直接调 claim 会 `409 PROFILE_ACTIVATION_REQUIRED`。
- `POST /v2/web/referral/claim` 拒绝原因去掉 `403 REFERRAL_CLAIM_WINDOW_CLOSED`，其余 reasonCode 不变。

### D. 后续移除计划

下一批 App 更新 codec（`claimWindowDays`、`claimWindow.closesAt` 改为可选并不再读取，`closed` 分支删除）并发版、且线上最低支持版本越过 build 42 后，另开批次：

1. 从 `GET /v2/referral.rules` 删 `claimWindowDays`；
2. `binding.claimWindow` 收敛为 `{status: open, activatedAt}` / unavailable（或整体删除）；
3. 删除 `referralLegacyClaimWindowDays`、`referralClaimWindowNoDeadline` 及 schema 中的 `closed` 枚举。

在此之前这两个键必须原样保留。

## 4. Tests

- `test/referral-contract.test.ts`：激活后恒 `open` + 哨兵 `closesAt`；未激活 `unavailable`；坏时间戳 400。
- `test/v2-referral-routes.test.ts`：激活 400 天后 App 面 claim 成功（`200`、写边、无拒绝事件）；`rules.claimWindowDays` 仍为 7；`closesAt` 为哨兵。
- `test/web-registration.test.ts`：激活 400 天后 web claim 成功；session 不含 `windowEndsAt`、`canClaim` 仍 true。
- `test/web-referral-dashboard.test.ts`：400 天前激活、未绑定 → `canClaim: true`。
- `test/web-registration.integration.test.ts`（PostgreSQL）：把 `activated_at` 改到 400 天前后 claim 成功并写入 depth 1 边，session 由 `canClaim: true` 变 `bound: true / canClaim: false`。
- `test/well-known-app-links-routes.test.ts`：落地页不再含「7 天」。
