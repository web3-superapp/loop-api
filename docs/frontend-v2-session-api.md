# 前端联调：V2 登录、注册与会话

本文是第一批 D0+D1 的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`；现有 Stream token 暂时继续使用冻结的 V1
接口。

## Base URL 与版本

- Development：`https://api-dev.quant-dinger.cc`
- V2 contract header：`X-Loop-Contract-Version: 2.0`
- 所有响应都应读取 `X-Request-ID`；错误体的 `correlationId` 与它相同。
- 账号、策略、能力和 Provider 响应均为 `Cache-Control: no-store`。

## 前端登录顺序

1. 使用 Privy Flutter SDK 完成 Email、Apple、Google 或外部钱包登录。
2. 从 SDK 取得当前 access token；不要读取、保存或上传 refresh token。
3. SDK 恢复出已登录状态时先调用 `GET /v2/account/me`。若本机已经保存了
   与返回 `accountId` 匹配的 active V2 session，不要再次 bootstrap。
4. 首次注册、`ACCOUNT_BOOTSTRAP_REQUIRED`、新设备/重装后本机没有 V2
   session，或完成 logout 后重新登录时，调用
   `POST /v2/session/bootstrap`。首次成功即完成 LOOP 注册，不存在 LOOP
   密码注册接口。
5. 在发出 bootstrap 前生成并持久化本次逻辑操作的 idempotency key 和完整
   metadata；超时或断网只能用完全相同的 key/metadata 重试。成功后原子保存
   opaque `accountId`、`sessionId` 和 `streamUserId`。不要从 Privy DID、
   邮箱、Alias 或钱包地址自行推导它们。
6. Chat/Video token 暂时调用 `POST /v1/chat/token` 与
   `POST /v1/video/token`；两者会读取同一个已 bootstrap 的 LOOP 账号。
7. 退出时为本次 logout 生成并持久化一个新 idempotency key，先尝试
   `POST /v2/session/logout`；随后断开 Stream Chat/Video client、清除本地
   Stream token/通信缓存，再调用 Privy SDK logout。LOOP logout 不撤销
   Privy Provider token。

不同登录方式是否属于同一个账号完全由 Privy 的 account-linking 配置与
SDK 流程决定。后端只认验证后的 Privy subject：相同 subject 恢复同一
`accountId`，不同 subject 永不按邮箱、钱包、昵称自动合并。

## 公共 metadata

### `GET /v2/meta/client-policy`

无需 Bearer、body 或 query。返回登录后默认路由 `community`、五个主 Tab
顺序，以及 version/region/terms 三个门禁。`unavailable` 不能解释为“允许”。

- `configVersion` / `effectiveAt` 是服务端当前策略快照，来自配置，**客户端
  不得写死为常量**（只校验格式：`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` 与
  RFC 3339 UTC）。
- `versionGate` 与 `termsGate` 是按 `status` 区分的联合类型：
  `"available" | "unavailable"`。旧枚举值 `active`、`accepted`、`required`
  已删除（从未下发过）。
- `regionGate` 目前恒为 `unavailable`：服务端尚未选定地区判定源。客户端不得
  用 locale / SIM / IP 自判地区，也不得把 `unavailable` 当作允许。

未配置时：

```json
{
  "contractVersion": "2.0",
  "configVersion": "productPolicyV2.2026-09-01",
  "effectiveAt": "2026-09-01T00:00:00.000Z",
  "defaultRoute": "community",
  "navigation": {
    "primaryTabs": ["community", "mining", "launch", "market", "wallet"]
  },
  "versionGate": {
    "status": "unavailable",
    "minimumSupportedVersions": { "ios": null, "android": null },
    "storeUrls": { "ios": null, "android": null },
    "reasonCode": "CLIENT_VERSION_POLICY_UNAVAILABLE"
  },
  "regionGate": {
    "status": "unavailable",
    "reasonCode": "REGION_POLICY_UNAVAILABLE",
    "supportUrl": null,
    "readOnlyAssetAccess": null
  },
  "termsGate": {
    "status": "unavailable",
    "requiredVersion": null,
    "reasonCode": "TERMS_POLICY_UNAVAILABLE"
  }
}
```

配置完整时的 `available` 分支（其余字段不变）：

```json
{
  "versionGate": {
    "status": "available",
    "minimumSupportedVersions": { "ios": "1.4.0", "android": "1.3.2" },
    "forceUpdateBelow": { "ios": "1.2.0", "android": "1.3.2" },
    "storeUrls": {
      "ios": "https://apps.apple.com/app/id0000000000",
      "android": "https://play.google.com/store/apps/details?id=app.loop"
    },
    "reasonCode": null
  },
  "termsGate": {
    "status": "available",
    "requiredVersion": "terms-2026-09",
    "reasonCode": null
  }
}
```

版本门禁语义（客户端用自身版本按 SemVer 2.0 比较，本接口不接收平台或
版本输入）：

| 客户端版本                                            | 行为                             |
| ----------------------------------------------------- | -------------------------------- |
| `< forceUpdateBelow[platform]`                        | `force-update` 页阻断，不可跳过  |
| `>= forceUpdateBelow` 且 `< minimumSupportedVersions` | 可关闭的更新提示                 |
| `>= minimumSupportedVersions[platform]`               | 正常进入                         |
| `versionGate.status = "unavailable"`                  | 不做版本判断，也不显示“已是最新” |

两个分支键集各自精确：`unavailable` 为 `status/minimumSupportedVersions/
storeUrls/reasonCode`；`available` 为 `status/minimumSupportedVersions/
forceUpdateBelow/storeUrls/reasonCode`。`forceUpdateBelow` 永不为 null（未
配置硬下限时等于 `minimumSupportedVersions`）。D0 的 `forceUpdate: null`
占位字段已删除。`termsGate.requiredVersion` 只说明
必须接受的条款版本；用户是否已接受属于后续认证模块。

**loop-mobile 现有解析器需同步修改**：`loop_v2_meta_repository.dart` 目前
把 `configVersion`/`effectiveAt` 与常量比较、只识别 `active`/`accepted`/
`required`、并对 `versionGate` 做精确键集校验（要求已删除的 `forceUpdate`，
不认识 `forceUpdateBelow`）。

### `GET /v2/meta/capabilities`

无需 Bearer、body 或 query。`availability` 表示当前后端配置/运行时状态，
`evidence` 单独表示真机或外部 Provider 验证是否完成。即使
`availability=available`，也不等于生产验收已经通过。

后端 `V2_MODULES_ENABLED` 启用了某模块但该模块尚未交付运行时时，对应
capability 从 `deferred` 变为
`{"availability": "unavailable", "reasonCode": "MODULE_RUNTIME_NOT_REGISTERED"}`，
客户端应按 unavailable 展示，不得视为即将可用。capability 列表仍固定 16
项，ID 集合不变。

## Bootstrap / 注册

`POST /v2/session/bootstrap`，无 body、无 query。

必需 headers：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
X-Loop-Platform: ios | android
X-Loop-Device-ID: <canonical lowercase UUIDv4 installation id>
Idempotency-Key: <canonical lowercase UUIDv4 for this logical bootstrap>
```

成功 `200`：

```json
{
  "account": { "accountId": "6d12a86e-4134-47e6-9312-c5ef75a30f55" },
  "session": {
    "sessionId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "deviceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "status": "active",
    "authStrength": "providerAuthenticated",
    "policyVersion": "sessionPolicyV1",
    "createdAt": "2026-09-02T01:00:00.000Z",
    "lastSeenAt": "2026-09-02T01:00:00.000Z",
    "revokedAt": null
  },
  "communication": {
    "streamUserId": "loop_6d12a86e413447e69312c5ef75a30f55"
  },
  "contractVersion": "2.0"
}
```

同一个 `Idempotency-Key` 只能重试完全相同的请求。超时后保留原 key 重试；
不能换 key 猜测结果。相同 key 配不同 device/platform/client version 会返回
`IDEMPOTENCY_CONFLICT`。

一个 key 只属于一次逻辑 bootstrap。完成 logout 后的新登录必须生成新 key。
不要重放已退出 session 的旧 bootstrap key：为了保证历史请求结果稳定，它仍会
返回当时创建的 `active` 投影，但不会重新激活数据库中已经 revoked 的 session。
创建限额为每账号 20 次/滚动 24 小时、每账号与 device 组合 5 次/滚动 24
小时；普通冷启动遵循上面的 `account/me` 恢复流程，不会消耗创建额度。

## 当前账号

`GET /v2/account/me`，无 body、无 query。

必需 headers：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

成功 `200`：

```json
{
  "account": { "accountId": "6d12a86e-4134-47e6-9312-c5ef75a30f55" },
  "authentication": {
    "provider": "privy",
    "authStrength": "providerAuthenticated"
  },
  "communication": {
    "streamUserId": "loop_6d12a86e413447e69312c5ef75a30f55"
  },
  "policyVersion": "sessionPolicyV1",
  "contractVersion": "2.0"
}
```

若 Privy token 有效但从未 bootstrap，返回
`ACCOUNT_BOOTSTRAP_REQUIRED`；App 应调用 bootstrap，而不是创建另一套
本地账号。

## Logout

`POST /v2/session/logout`，无 body、无 query。在 bootstrap headers 基础上
增加：

```text
X-Loop-Session-ID: <sessionId returned by bootstrap>
```

本次逻辑 logout 必须使用新的 `Idempotency-Key`。成功 `200`：

```json
{
  "session": {
    "sessionId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "status": "revoked",
    "revokedAt": "2026-09-02T02:00:00.000Z"
  },
  "providerLogoutRequired": true,
  "contractVersion": "2.0"
}
```

`providerLogoutRequired=true` 时必须继续执行 Privy SDK logout。已撤销的本地
sessionId 不是 API credential；只要当前 Privy Bearer 仍有效，受保护请求仍按
Privy token 鉴权。

Logout 的同一逻辑重试必须复用同一 key。新 logout command 限额为每账号
40 次/滚动 24 小时、同一个 requested session 5 次/滚动 24 小时；exact-key
replay 不重复消耗限额。若 LOOP logout 返回 `SESSION_NOT_FOUND`，仍按本地退出
继续；它不会说明 session 不存在、属于其他账号，还是已经不可解析。

若 LOOP logout 因离线、超时、500 或 503 无法确认，不得把用户困在 App
登录态：将本地状态标记为“后端审计撤销未确认”，立即断开两个 Stream client、
清除 Stream token/通信缓存并执行 Privy SDK logout。只有在当前 Privy token
仍有效时才能用原 key 做有界重试；不得换 key，也不得向用户显示“服务端已
撤销”。Stream user token 最长仍可能在服务端签名有效期内有效，因此客户端
断开连接和清除本地 token 是退出闭环的必需步骤。

## 错误模型

V2 错误固定只有以下字段：

```json
{
  "code": "INVALID_REQUEST",
  "category": "validation",
  "retryable": false,
  "userMessageKey": "errors.request.invalid",
  "correlationId": "00000000-0000-4000-8000-000000000000",
  "detailsSafe": null,
  "providerReferenceSafe": null
}
```

本批前端需要处理的 code：

| Code                                               | 建议行为                                        |
| -------------------------------------------------- | ----------------------------------------------- |
| `AUTH_REQUIRED` / `AUTH_INVALID`                   | 回到 Privy session 恢复或登录                   |
| `ACCOUNT_BOOTSTRAP_REQUIRED`                       | 使用同一当前 Privy token 调 bootstrap           |
| `VERSION_CONFLICT`                                 | 停止请求并走版本策略；不要降级猜测              |
| `IDEMPOTENCY_CONFLICT`                             | 停止重试并记录 `correlationId`                  |
| `SESSION_NOT_FOUND`                                | 不枚举原因；继续清理本地状态并执行 Privy logout |
| `RATE_LIMITED`                                     | 有界退避，不要换 key 制造新 session             |
| `CAPABILITY_UNAVAILABLE` / `PROVIDER_DISCONNECTED` | 展示暂不可用，不伪装成功                        |
| `REQUEST_TIMEOUT`                                  | 同一逻辑操作保留原 idempotency key 查询/重试    |
| `INTERNAL_ERROR`                                   | 展示通用错误并记录 `correlationId`              |

完整错误码族（含 `AUTH_STEP_UP_REQUIRED`、`PERMISSION_DENIED`、
`REGION_BLOCKED`、`DATA_STALE`、`CHAIN_MISMATCH`、`QUOTE_EXPIRED`、
`INSUFFICIENT_BALANCE`、`SIMULATION_FAILED`、`POLICY_BLOCKED`、
`SUBMISSION_UNKNOWN`、`INDEXING_DELAYED`、`MAINTENANCE`、
`VALIDATION_FAILED`、`NOT_FOUND`）及每个 code 固定的 HTTP 状态、
`category`、`retryable`、`userMessageKey` 见
`docs/api-v2-conventions.md` 的 “Error code family” 表；`category` 枚举固定
八个值。本批接口只会返回上表列出的 code。

## 当前验收状态

- 已通过：TypeScript、lint、契约、路由、错误脱敏、V1 字节冻结、OpenAPI
  双产物，以及 PostgreSQL migration/repository 自动化后端门禁（以仓库最近
  一次测试报告为准）。
- 待前端真机：Email、Apple、Google、外部钱包四种入口的首次/重复/取消/
  token 过期/弱网/退出；Privy linking 后同一用户是否稳定返回同一
  `accountId`。
- 待 Stream 真机：用 bootstrap 的 `streamUserId` 分别取得 Chat/Video token，
  两台实体手机连接 Development App 与测试频道。消息、历史、已读、输入态、
  在线态和通话状态继续由 Stream SDK 负责。
