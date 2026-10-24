# 0180 · 官网「我的邀请」面板 `GET /v2/web/referral/me`（S297，2026-10-24）

## 1. Status

已实现（分支 `S297-web-referral-me`，基线 `integration/v2` `7dd209a`）。**无迁移**、无新依赖、无新 env（复用 `V2_CURSOR_HMAC_SECRET`、`PUBLIC_BASE_URL`、`WEB_ORIGINS`）。只改 `openapi/loop-web.v2.json`（新增一条路径）；`loop-api.v1.json` / `loop-api.v2.json` / `loop-admin.v1.json` / `loop-public.v1.json` 字节不变，App 现有路由响应不变。

先例：0179（web 面挂载、CORS、鉴权、错误信封）、0036（邀请关系）、0162（邀请中心 stats / 邀请列表 / 「有效」口径）、0166（`REFERRAL_CENTER_EMIT` 只是 App 解码开关）。

## 2. Context

需求方 10-24 原型「Web 预注册邀请」：网页注册后要有「我的邀请」面板，显示自己的邀请码、邀请链接、已邀请人数、邀请记录、我的邀请人。全部走正式接口、与 App 邀请中心口径一致。

需求单还列了 `GET /v2/web/profile/username-suggestion`（复用 App「换一个」）。核实结果：App 的「换一个」**纯客户端**（`loop-mobile/lib/features/profile/profile_v2_screens.dart` 的 `loopLocalAliasSuggestion`：8 个词干 `Voyager/Signal/Ledger/Orbit/Cipher/Harbor/Nimbus/Quartz` + `_` + 两位数 10–99，按当前微秒取；`loop_id_setup_screen.dart` 与资料编辑页共用），服务端没有生成逻辑，用户名本来就可重名、服务端只负责拒绝。按任务单约定**不做该接口**，网站照抄这条客户端规则即可。

## 3. Decision

### A. 路由、鉴权与请求头

`GET /v2/web/referral/me[?cursor=]`，在 0179 的 web 插件内（同一 CORS、`WEB_ORIGINS` 空则 404、七字段错误信封、拒绝原因放 `detailsSafe.reasonCode`）。

- 鉴权：`Authorization: Bearer <Privy access token>`，`authenticateLoopBearer`（账号不存在 → 409 `ACCOUNT_BOOTSTRAP_REQUIRED`）。
- **按 0179 对读接口的既定做法：不要求、也不读** `X-Loop-Contract-Version`、`Idempotency-Key`、任何设备头（0179 §C：「reads carry nothing but (where needed) the Bearer」；契约版本头只在写接口校验）。发了也忽略，不报错。CORS 允许头不用改。
- query 只允许 `cursor`（其它 key / body → 400）。

### B. 响应

```json
{
  "code": "LOOP-7HJKM",
  "inviteLink": "https://api-staging.quant-dinger.cc/i/LOOP-7HJKM",
  "stats": {
    "direct": 2,
    "valid": 1,
    "deeper": 1,
    "pendingVerification": 1,
    "validAsOf": "2026-10-24T03:00:00.000Z"
  },
  "invitees": [
    {
      "loopId": "LOOP-ABCD1234",
      "username": "Bob",
      "depth": 1,
      "status": "valid",
      "joinedAt": "2026-10-23T10:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "inviter": { "loopId": "LOOP-WXYZ5678", "username": "Alice" },
  "binding": {
    "bound": true,
    "windowEndsAt": "2026-10-30T10:00:00.000Z",
    "canClaim": false
  },
  "observedAt": "2026-10-24T10:00:00.000Z"
}
```

比任务单多两个字段：`inviteLink`（面板要显示链接，与 App 分享的同一条 `{PUBLIC_BASE_URL}/i/{code}`；配了 `WEB_BASE_URL` 后没装 App 的访问 302 到网站）、`stats.validAsOf`（「有效」读的是哪个结算小时，与 App 的 `stats.validAsOf` 同义）。

### C. 口径（全部复用 App 邀请中心的同一 service / repository）

新增 `ReferralService.getDashboard`（`src/features/referral/referral-service.ts`），一次读：`ensureInviteCode`（与 `GET /v2/referral` 同一函数）、`getAccountState`、`getDirectEdge`、`getLatestSettledEpochId` → `getInviteeStats`（与 App 同一 SQL、同一钉住的结算小时）、`listDirectInvitees`（与 `GET /v2/referral/invitees` 同一 SQL）。web 服务只做字段映射，再用 0179 的 `getDirectInviter` 取「我的邀请人」。不受 `REFERRAL_CENTER_EMIT` 影响（那是 App 旧包解码开关，网站没有旧包）。

| 字段                         | 口径                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `code`                       | 账号自己的邀请码。**生成时机：账号第一次读邀请中心时惰性签发**（App `GET /v2/referral` 或本接口，谁先谁签），一人一个、随机、唯一、永不变。**不要求先起名**：只要 `POST /v2/web/session` 建了账号，本接口就一定返回 code（所以 `code` 不会是 null）。未起名的人的码别人也能用（preview 显示 `username: null`）；但他自己绑别人的码仍须先起名（0179）。 |
| `stats.direct`               | 生效中的直接邀请（depth 1，`effective_to` 为空）= App `stats.directCount`                                                                                                                                                                                                                                                                              |
| `stats.valid`                | 其中被邀请人本人在**最近一个已结算小时**自有算力 > 0 的人数 = App `stats.validCount`                                                                                                                                                                                                                                                                   |
| `stats.deeper`               | 生效中的 2–5 级关系数 = App `stats.level2to5Count`                                                                                                                                                                                                                                                                                                     |
| `stats.pendingVerification`  | `direct − valid`                                                                                                                                                                                                                                                                                                                                       |
| `stats = null`               | 还没有任何已结算小时（「有效」无从判断）或 stats 读取失败——**未知给 null，不给 0**。此时 `invitees` 照常返回，状态都是 `pending`。                                                                                                                                                                                                                     |
| `invitees`                   | **只给直接邀请（depth 1）**，与 App 邀请列表同口径：生效与已失效都列，按绑定时间倒序（同时刻按关系 ID），每页 100 条；`depth` 恒为 1（字段留着以后扩）。`status`：`valid`（同上「有效」）/ `pending`（生效但未有效）/ `void`（关系已失效，App 的 `invalid`）。                                                                                         |
| `invitees[].loopId/username` | 只给 LOOP ID 与用户名（资料 active 才有用户名，否则 null）；**不给**邮箱、钱包、资料 ID、头像。被邀请人拉黑了我 → `loopId` 与 `username` 都为 null（App 同规则隐藏资料）。                                                                                                                                                                             |
| `nextCursor`                 | 超过 100 条时给，下一页 `GET …/referral/me?cursor=`（游标绑定本人、HMAC 签名，路由域 `webReferralDashboard`，与 App 列表游标不通用）；其它字段每页重读。                                                                                                                                                                                               |
| `inviter`                    | 我的直接上级（depth 1 边，含已失效，与 `binding.bound` 同口径）的 LOOP ID 与用户名；未绑为 null。                                                                                                                                                                                                                                                      |
| `binding`                    | 与 `POST /v2/web/session` 的 `invite` 同义：`bound` 有过 depth-1 边；`windowEndsAt` 起名时刻 + 7 天，未起名 null；`canClaim` 未绑且窗口未关（未起名为 true，含义「起名后可绑」）。                                                                                                                                                                     |

副作用：首次读会写一行 `invite_codes` + 一条 `invite_code_issued` 审计（与 App 的 GET 相同），天然幂等（并发签发在锁内回读已有码）。

### D. 错误码

| HTTP | code                                        | reasonCode                                                                                                                                                                                           |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                           | 未知 query、带 body、游标无效 / 非本人 / 来自 App 列表                                                                                                                                               |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID`            | —（带 `WWW-Authenticate`）                                                                                                                                                                           |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`                | 先 `POST /v2/web/session`                                                                                                                                                                            |
| 500  | `INTERNAL_ERROR`                            | —                                                                                                                                                                                                    |
| 503  | `CAPABILITY_UNAVAILABLE`                    | `V2_REFERRAL_MODULE_DEFERRED`（referral 模块未开）、`V2_CURSOR_NOT_CONFIGURED`（无 `V2_CURSOR_HMAC_SECRET`）、`WEB_REPOSITORY_UNAVAILABLE`（上级读取失败）、无 reasonCode（邀请仓库 / 数据库不可用） |
| 503  | `PROVIDER_DISCONNECTED` / `REQUEST_TIMEOUT` | Privy 未配置 / 超时                                                                                                                                                                                  |

### E. unavailable（fail closed）

- `WEB_ORIGINS` 空：不挂载（404）。
- `V2_MODULES_ENABLED` 不含 `referral`：503 `V2_REFERRAL_MODULE_DEFERRED`。
- 无游标密钥：整条 503 `V2_CURSOR_NOT_CONFIGURED`（与 App `GET /v2/referral/invitees` 一致，不因数据量少就「碰巧」可用）。
- 结算小时缺失：`stats: null`，不编造 0。
- 无 fixture、无假成功。

### F. 代码位置

`src/features/referral/referral-service.ts`（`getDashboard`、`referralDashboardPageSize = 100`）、`src/features/referral/referral-repository.ts` + `src/database/referral-repository.ts`（`ReferralInviteeRecord.loopId`：列表 SQL 多 join `loop_users`，拉黑时 null；App 映射不输出该字段）、`src/features/web/web-registration-contract.ts` / `web-registration-service.ts`（`referralDashboard`）、`src/routes/v2/web.ts`（route schema）。

## 4. 风险与未做

- 被邀请人的 `loopId` 是新暴露给邀请人的字段（App 列表只给 `publicProfileId`）。LOOP ID 本身已在 preview / claim 中公开展示，且拉黑时隐藏；如主代理认为邀请人不应看到下级 LOOP ID，可改为只给 username。
- 只列直接邀请；2–5 级只有计数（`deeper`）。如网站要列间接下级，需另立决策（App 也没有该列表）。
- `invitees` 的「有效」用列表 SQL 当时的最新结算小时，stats 用请求开始时钉住的结算小时；跨小时边界的一瞬间两者可能差一小时（App 同）。
- 用户名建议接口未做（见 §2）。

## 5. 证据

- `test/web-referral-dashboard.test.ts`（15）：完整形状与映射、隐私字段不出现、未起名时首读签发 code、stats null（无结算小时 / 读失败）、窗口关闭、100 条分页与游标（含拒绝垃圾游标）、未知 query、未鉴权 / 未建号、不读契约 / 幂等头、模块关、游标密钥缺失、仓库失败七字段信封、上级读失败、未挂载、OpenAPI 契约（只有 `cursor` 参数、Bearer、封闭响应、必需字段）。
- `test/web-referral-dashboard.integration.test.ts`（2，真实 PostgreSQL）：未起名账号的 code（首读签发、稳定、入库一行、别人可 preview）；一个邀请人 + 两个被邀请人（结算前 stats null 全 pending；结算后一个 valid 一个 pending、deeper=1、倒序）、被邀请人看到的上级与 binding、拉黑后隐藏身份。
