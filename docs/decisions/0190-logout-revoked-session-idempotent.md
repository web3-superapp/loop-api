# 决策 0190：对已撤销 session 的 logout 幂等返回 200（S320-api + S320-mobile）

- 状态：已采纳（S320-api），客户端侧 S320-mobile 同批
- 日期：2026-10-28
- 基线：`3d5da62`（integration/v2）
- 依据：staging 2026-10-27 13:35 UTC 起，一台测试机每次启动都先 `GET /v2/account/me` → 200，再 `POST /v2/session/logout` → 401 `AUTH_INVALID`（`invalid_access_token`），成串重复。库里该用户的 device session 已在 13:35:27 由 logout command 撤销（`device_session_commands` 结果 `revoked`），但 App 本地 journal 没收到那次响应，仍把 logout 记为待确认，每次 bootstrap 用原 key 和 `X-Loop-Session-ID: <已撤销 id>` 重放。

## 1. 根因

`authenticateLoopBearer`（决策 0037 复核）对任何带已撤销 `X-Loop-Session-ID` 的请求返回 401。这条规则对普通路由正确，但 logout 本身的目标就是这个 session——它被同一规则拒掉，重放永远到不了幂等的 command 层。客户端 `_reconcileLogout` 只容忍 `404 SESSION_NOT_FOUND`，于是 bootstrap 一直抛错。

## 2. 服务端改动

- 认证服务 `authenticateLoopBearer(rawHeaders, { allowRevokedSession })` 增加选项；hooks 新增 `authenticateLoopBearerAllowingRevokedSession`，**只有** `POST /v2/session/logout` 使用。它仍逐请求校验 Privy Bearer、仍要求 LOOP 账号存在（否则 409 `ACCOUNT_BOOTSTRAP_REQUIRED`），只是不再因 session 已撤销而拒绝。
- 全局规则不变：其他路由（含 `GET /v2/account/me`、`/v2/devices/*`）带已撤销 session id 仍 401。`POST /v2/devices/{sessionId}/revoke` 保持原语义——调用方 session 已撤销就不能撤销别人（认证层 401，事务内再查一次 `DeviceSessionCallerInvalidError`）。
- command 层无需改：`device_session_commands` 原 key 精确 replay 返回原结果；新 key 命中已撤销行时返回该行（原 `revokedAt`），不重复写 `session_revoked` 事件、不重复退推送 token。

## 3. logout 返回

| 情况                     | 返回                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| 活跃 session             | 200 `revoked`，`revokedAt` = 本次撤销时间                          |
| 已撤销 session，原 key   | 200 `revoked`，原 `revokedAt`（replay，不耗限额）                  |
| 已撤销 session，新 key   | 200 `revoked`，原 `revokedAt`（计入每 session 5 次 / 24 小时限额） |
| 不存在或属于其他账号     | 404 `SESSION_NOT_FOUND`（不枚举）                                  |
| 同 key 不同 digest       | 409 `IDEMPOTENCY_CONFLICT`                                         |
| Privy Bearer 缺失 / 无效 | 401 `AUTH_REQUIRED` / `AUTH_INVALID`                               |

## 4. 客户端跟进（S320-mobile）

`loop_v2_session_coordinator.dart` 的 `_reconcileLogout` 在重放待确认 logout 时也容忍 401（视为该 session 已在服务端失效，清掉 journal 条目继续本地退出），这样旧版服务端或其他 401 场景也不会把 bootstrap 卡死。两侧任一上线即可解开卡死；都上线后是双保险。
