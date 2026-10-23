# 前端联调：官网注册写面 `/v2/web/*`（S295，决策 0179）

给 `loop-web`（Next.js）用。权威机器契约：`openapi/loop-web.v2.json`（`pnpm openapi:generate` 产出）。决策全文：`docs/decisions/0179-web-registration-surface.md`。

## 0. 流程总览

```text
Privy 登录（邮箱验证码 / Google）→ getAccessToken()
  → POST /v2/web/session                     拿 loopId / usernameRequired / invite
  → [usernameRequired] PUT /v2/web/profile/username   起用户名（=激活，开始 7 天绑码窗口）
  → [有邀请码 且 invite.canClaim] POST /v2/web/referral/claim
  → 完成页：GET /v2/web/meta 给下载链接；App 里用同一邮箱 / Google 登录即同一账号
落地页 /i/{code}：GET /v2/web/referral/preview?code=… 显示「XX 邀请你」并预填
```

**顺序要求**：绑码必须在用户名之后（未起名 → 409 `PROFILE_ACTIVATION_REQUIRED`）。邀请码请在落地页存起来（URL / sessionStorage），起名成功后再 claim。

## 1. Base URL、CORS 与 headers

- Base URL：API 源本身。Development `https://api-dev.quant-dinger.cc`，Staging `https://api-staging.quant-dinger.cc`。
- **CORS**：只有服务端 `WEB_ORIGINS` 里列出的网站 origin 能跨域读（逐字匹配 `scheme://host[:port]`，大小写 / 尾斜杠服务端已规范化；`www.` 与裸域是两个 origin，要分别列）。响应回显你的 origin（不是 `*`），带 `Vary: Origin`。**不要**用 `credentials: "include"`（没有 cookie，token 走头）。本地开发：非 production 环境可把 `http://localhost:3000` 加进 `WEB_ORIGINS`。
- `WEB_ORIGINS` 为空时整个 `/v2/web/*` 不存在（404）——联调前先确认服务端已配置。
- 预检：浏览器会自动发 `OPTIONS`；服务端放行方法 `GET, POST, PUT, OPTIONS`，头 `authorization, content-type, idempotency-key, x-loop-contract-version`，缓存 600 s。可读响应头：`retry-after`、`x-request-id`。

| 接口                                 | `Authorization: Bearer <Privy access token>` | `X-Loop-Contract-Version: 2.0` | `Idempotency-Key` | `Content-Type: application/json`              |
| ------------------------------------ | -------------------------------------------- | ------------------------------ | ----------------- | --------------------------------------------- |
| `POST /v2/web/session`               | 必须                                         | 必须                           | 必须              | 有 body（`{}`）时必须；也可不发 body 不带该头 |
| `PUT /v2/web/profile/username`       | 必须                                         | 必须                           | 必须              | 必须                                          |
| `POST /v2/web/referral/claim`        | 必须                                         | 必须                           | 必须              | 必须                                          |
| `GET /v2/web/referral/preview?code=` | 不需要                                       | 不需要                         | 不需要            | —                                             |
| `GET /v2/web/meta`                   | 不需要                                       | 不需要                         | 不需要            | —                                             |

- **不要**发 `X-Loop-Client-Version` / `X-Loop-Device-ID` / `X-Loop-Platform`：网页不是 App 安装，服务端不读、不建设备会话。
- `Idempotency-Key`：**小写**规范 UUIDv4（`crypto.randomUUID()` 即可；大写会 400）。一次用户动作一个 key；网络重试同一动作用同一个 key。
- Privy token：`const token = await getAccessToken()`（`@privy-io/react-auth` 的 `usePrivy()`），每次请求前取（SDK 会自动刷新）。必须是**与 App 同一个 Privy App ID** 的 token。token 不要打印、不要存 localStorage 以外的地方、不要拼进 URL。
- 所有响应 `Cache-Control: no-store`。

## 2. `POST /v2/web/session`

Privy 登录成功后调用；首次自动建 LOOP 账号（生成 LOOP ID），之后（网页或 App）都返回同一个账号。可反复调用（刷新页面时用它恢复状态）。

```http
POST /v2/web/session
Authorization: Bearer eyJ…
X-Loop-Contract-Version: 2.0
Idempotency-Key: 3f1c2a9e-7b4d-4c1e-9a2b-5d6e7f8a9b0c
Content-Type: application/json

{}
```

```json
{
  "loopId": "LOOP-7HJK2MNP",
  "username": null,
  "usernameRequired": true,
  "walletAddress": null,
  "invite": { "bound": false, "windowEndsAt": null, "canClaim": true },
  "observedAt": "2026-10-23T10:00:00.000Z"
}
```

| 字段                  | 含义                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `loopId`              | `LOOP-` + 8 位 Crockford Base32，展示用                                                                                      |
| `username`            | 已起的用户名；未起为 null                                                                                                    |
| `usernameRequired`    | true → 先走起名页                                                                                                            |
| `walletAddress`       | LOOP 已知的钱包地址（小写 0x…）；网页新用户在打开 App 前通常是 null，要立即显示嵌入式钱包请直接用 Privy SDK 的 `user.wallet` |
| `invite.bound`        | 已绑过上级（一人只能绑一次）                                                                                                 |
| `invite.windowEndsAt` | 绑码截止时间（起名时刻 + 7 天）；未起名为 null                                                                               |
| `invite.canClaim`     | 还能绑：未绑、邀请模块可用、窗口没关。未起名时也是 true（意思是「起名后可绑」）                                              |

## 3. `PUT /v2/web/profile/username`

```http
PUT /v2/web/profile/username
Authorization: Bearer eyJ…
X-Loop-Contract-Version: 2.0
Idempotency-Key: 0b8e4d1a-2c3f-4a5b-8c6d-7e8f9a0b1c2d
Content-Type: application/json

{ "username": "小明" }
```

```json
{ "username": "小明" }
```

规则与 App 完全一致：前后空格去掉后 1–40 个字符（Unicode 码点）、不能含控制 / 不可见字符、**可以重名**；保留词（loop / admin / official / support / system / mod / moderator / team 等）与运营屏蔽词不行。第一次调用会「激活」账号并开始 7 天绑码窗口；之后再调就是改名。

## 4. `POST /v2/web/referral/claim`

```http
POST /v2/web/referral/claim
Authorization: Bearer eyJ…
X-Loop-Contract-Version: 2.0
Idempotency-Key: 9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d
Content-Type: application/json

{ "code": "LOOP-7HJKM" }
```

```json
{ "status": "bound", "inviterLoopId": "LOOP-ABCD1234" }
```

- `code`：`LOOP-XXXXC`；大小写、有无 `LOOP-` 前缀、I/L/O 形近字服务端会规范化，原样传用户输入即可（≤ 32 字符）。
- `status: "already_bound"`：这个账号早就绑过（网页或 App）。如果原上级就是这个码的主人，带 `inviterLoopId`；否则不带（不暴露别的上级）。当成功处理即可。
- 同一个 `Idempotency-Key` 重试返回第一次的结果。

## 5. `GET /v2/web/referral/preview?code=`（无鉴权）

```http
GET /v2/web/referral/preview?code=LOOP-7HJKM
```

```json
{ "valid": true, "inviter": { "username": "Alice", "loopId": "LOOP-ABCD1234" } }
```

- 码格式不对或没人拥有 → `{ "valid": false, "inviter": null }`（200）。
- `inviter.username` 可能为 null（对方还没起名）→ 显示「LOOP-ABCD1234 邀请你」。
- 限流：每个访客每分钟 `PUBLIC_RATE_LIMIT_PER_MINUTE` 次（默认 120），超出 429，读 `Retry-After` 秒后再试；页面里同一个码只请求一次。
- 不需要 Bearer / 契约头；`?code=` 必填（缺失 400），不要带其它 query。

## 6. `GET /v2/web/meta`（无鉴权）

```json
{
  "appStore": {
    "ios": "https://apps.apple.com/app/id0000000000",
    "android": "https://example.com/loop.apk",
    "testflight": "https://testflight.apple.com/join/XXXXXX"
  },
  "observedAt": "2026-10-23T10:00:00.000Z"
}
```

任一项未配置为 null → 隐藏对应按钮。不要带任何 query。

## 7. `/i/{code}` 邀请链接

App 里分享出去的邀请链接仍是 `{API 域名}/i/{code}`。服务端配了 `WEB_BASE_URL` 后，**没装 App** 的访问会被 302 到 `${WEB_BASE_URL}/i/{code}`（code 原样，已做 URL 编码）。所以网站必须实现 `/i/[code]` 页面：调 preview 显示邀请人、把 code 存起来、引导 Privy 登录 → 注册。装了 App 的手机由系统直接拉起 App，不经过网站。

## 8. 错误

错误体固定七个字段：

```json
{
  "code": "POLICY_BLOCKED",
  "category": "authorization",
  "retryable": false,
  "userMessageKey": "errors.policy.blocked",
  "correlationId": "8a3f…",
  "detailsSafe": { "reasonCode": "REFERRAL_CLAIM_WINDOW_CLOSED" },
  "providerReferenceSafe": null
}
```

按 `code` + `detailsSafe.reasonCode` 分支；`correlationId` 给用户 / 客服排查。

| HTTP | `code`                             | `reasonCode`                   | 出现在                 | 前端处理                                                             |
| ---- | ---------------------------------- | ------------------------------ | ---------------------- | -------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`                  | —                              | 全部                   | 头 / body 不对（检查小写 UUID、契约头、JSON）                        |
| 400  | `INVALID_REQUEST`                  | `REFERRAL_CODE_INVALID`        | claim                  | 「邀请码格式不对」                                                   |
| 401  | `AUTH_REQUIRED` / `AUTH_INVALID`   | —                              | session/username/claim | token 缺失或失效 → 重新 `getAccessToken()`，仍失败则重新登录         |
| 403  | `POLICY_BLOCKED`                   | `REFERRAL_CLAIM_WINDOW_CLOSED` | claim                  | 「注册已超过 7 天，不能再绑定邀请码」                                |
| 404  | `NOT_FOUND`                        | `REFERRAL_CODE_UNKNOWN`        | claim                  | 「邀请码不存在」                                                     |
| 404  | `NOT_FOUND`                        | —                              | 全部                   | 服务端没开 web 面（`WEB_ORIGINS` 空）或路径错                        |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED`       | —                              | username/claim         | 先调 `POST /v2/web/session`                                          |
| 409  | `PROFILE_ACTIVATION_REQUIRED`      | `PROFILE_ACTIVATION_REQUIRED`  | claim                  | 先起用户名                                                           |
| 409  | `IDEMPOTENCY_CONFLICT`             | —                              | username/claim         | 同一个 key 换了内容 → 换新 key                                       |
| 409  | `VERSION_CONFLICT`                 | —                              | 写接口                 | `X-Loop-Contract-Version` 不是 `2.0`；改名时极少数并发冲突，重试一次 |
| 409  | `DATA_STALE`                       | `REFERRAL_ALREADY_BOUND`       | claim                  | 兜底（正常会是 200 `already_bound`）                                 |
| 422  | `VALIDATION_FAILED`                | —                              | username               | 「用户名 1–40 个字符」                                               |
| 422  | `ALIAS_RESERVED` / `ALIAS_BLOCKED` | —                              | username               | 「该用户名不可用」                                                   |
| 422  | `VALIDATION_FAILED`                | `REFERRAL_SELF_INVITE`         | claim                  | 「不能填写自己的邀请码」                                             |
| 422  | `VALIDATION_FAILED`                | `REFERRAL_CYCLE`               | claim                  | 「不能绑定自己邀请的人」                                             |
| 429  | `RATE_LIMITED`                     | `WEB_RATE_LIMITED`             | preview                | 读 `Retry-After`                                                     |
| 500  | `INTERNAL_ERROR`                   | —                              | 全部                   | 提示稍后再试，带 `correlationId`                                     |
| 503  | `PROVIDER_DISCONNECTED`            | —                              | 带 Bearer 的           | Privy 校验不可用，稍后再试                                           |
| 503  | `CAPABILITY_UNAVAILABLE`           | `WEB_SESSION_DISABLED`         | session                | 服务端关了 V2 会话                                                   |
| 503  | `CAPABILITY_UNAVAILABLE`           | `V2_PROFILE_MODULE_DEFERRED`   | username               | 服务端未开资料模块                                                   |
| 503  | `CAPABILITY_UNAVAILABLE`           | `V2_REFERRAL_MODULE_DEFERRED`  | claim/preview          | 服务端未开邀请模块；隐藏绑码 UI                                      |
| 503  | `CAPABILITY_UNAVAILABLE`           | `WEB_REPOSITORY_UNAVAILABLE`   | 全部                   | 数据库不可用，稍后再试                                               |
| 503  | `REQUEST_TIMEOUT`                  | —                              | 全部                   | 超时，可重试（写接口用同一个 key）                                   |

## 9. unavailable 行为汇总

服务端缺配置时一律失败关闭，不会返回假成功：没配 `WEB_ORIGINS` → 404；Privy 没配 → 503；模块没开 → 对应接口 503（session 里 `canClaim` 为 false）；下载链接没配 → `meta` 里为 null。

## 10. 最小示例（TypeScript）

```ts
const API = process.env.NEXT_PUBLIC_LOOP_API_BASE_URL!;

async function web<T>(
  method: "POST" | "PUT",
  path: string,
  token: string,
  body: unknown,
  key: string = crypto.randomUUID(),
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Loop-Contract-Version": "2.0",
      "Idempotency-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw json; // { code, detailsSafe: { reasonCode }, correlationId, … }
  return json as T;
}

// const token = await getAccessToken();
// const me = await web("POST", "/v2/web/session", token, {});
// if (me.usernameRequired) await web("PUT", "/v2/web/profile/username", token, { username });
// if (code && me.invite.canClaim) await web("POST", "/v2/web/referral/claim", token, { code });
```
