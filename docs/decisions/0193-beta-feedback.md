# 决策 0193：内测反馈——截图上传 / 提交 / 我的 / 后台分诊（S332-api，主代理决策 0262）

- 状态：已采纳（S332-api），仅 Development / BSC Testnet
- 日期：2026-11-02
- 基线：`fa7c6b6`（integration/v2）
- 依据：`LOOP/docs/52-内测反馈入口与个人主页无数据-2026-11-02.md` §一、§二；主代理 2026-11-02 合同修正（后台路由挂 `/admin/v1`、权限分级、列表 / 详情形状）。

## 1. 实体与稳定 ID

| 实体                        | 主键                                       | 说明                                                                                                                             |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `beta_feedback`             | `id` uuid（服务端生成 UUIDv4，opaque）     | `account_id` → `loop_users.id`；`category` bug / suggestion / other；`body` 1–2000 码点；`context` jsonb；`status`；`admin_note` |
| `beta_feedback_attachments` | `(feedback_id, sort)`；`media_id` 全表唯一 | 至多 4 张，`sort` 0..3 即展示顺序；一张截图只能挂一条反馈                                                                        |
| `media_objects`（新 kind）  | `media_id`                                 | `feedback_image`：归属上传者，不 pin IPFS，不可作 avatar / logo ref                                                              |

钱包地址、LOOP ID、alias 都不作键；后台展示的 `account.loopId` / `account.displayName` 是读时 join。

## 2. 状态机

`open`（创建时）→ `triaged` / `resolved` / `wont_fix`，后台任意互转（含回到 `open`）；App 端只读。每次后台 PATCH 写一行 `admin_audit_log`：动作 `beta_feedback.update`、目标 `beta_feedback`、`before` / `after` = `{status, adminNote}`（`after.changed` 标是否真变），与改动同一事务。

## 3. 规则

- 正文：CRLF→LF 后 trim，1–2000 码点；含 NUL 拒绝。
- `mediaIds`：可缺省（= []），≤ 4，不重复；每个必须是**本账号**的 `feedback_image`、上传于 24 小时内、未挂到其他反馈。
- `context`：只收 `appVersion` `build` `platform` `osVersion` `deviceModel` `route` `locale`；字符串 trim、去控制字符、截到 200 码点；数字转字符串（`build` 可能是整数）；其他键、其他类型、空串一律丢弃。数据库 CHECK 同样只允许这七个键。
- 日限额：每账号滚动 24 小时 ≤ 20 条（不是自然日，避开时区问题）。
- 幂等：`Idempotency-Key` + 规范化请求 SHA-256 存在行上（账号内唯一）。同键同体 → 200 原结果；同键异体 → 409 `IDEMPOTENCY_CONFLICT`。建单在账号行锁（`loop_users ... for update`）下执行，幂等查询、限额、截图校验不会与同账号并发请求竞态。
- 截图转码：输入规则与 0095 / project-nft-images 相同（按内容识别 JPEG/PNG/WebP/HEIC、≤ 5 MiB、两边 ≥ 64 px、去元数据、WebP q82、每分钟 6 次共享限额）。**输出与头像 / NFT 图不同**：保持宽高比，缩到 1440×1440 以内、不放大（而不是 512×512 居中裁切——手机竖屏截图被裁成中间方块就看不清问题了）；超过存储上限 1 MiB 时降到 1080 / q70 重编一次，仍超则 422 `MEDIA_TOO_LARGE`。响应形状不受影响。

## 4. 错误码（detailsSafe.reasonCode）

| HTTP | code                     | reasonCode                                                                                                                |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`        | —（未知顶层键、category 非枚举、mediaIds 非数组、坏 cursor）                                                              |
| 409  | `IDEMPOTENCY_CONFLICT`   | —                                                                                                                         |
| 422  | `VALIDATION_FAILED`      | `FEEDBACK_BODY_EMPTY` / `FEEDBACK_BODY_TOO_LONG` / `FEEDBACK_BODY_INVALID`（field `body`）                                |
| 422  | `VALIDATION_FAILED`      | `FEEDBACK_TOO_MANY_IMAGES` / `MEDIA_NOT_OWNED` / `FEEDBACK_MEDIA_IN_USE` / `FEEDBACK_MEDIA_DUPLICATE`（field `mediaIds`） |
| 422  | `VALIDATION_FAILED`      | 上传：`MEDIA_TYPE_UNSUPPORTED` / `MEDIA_TOO_LARGE` / `MEDIA_DIMENSIONS_TOO_SMALL` / `MEDIA_DECODE_FAILED`                 |
| 429  | `RATE_LIMITED`           | `FEEDBACK_DAILY_LIMIT`（`limit: 20`）；上传每分钟限额无 reasonCode                                                        |
| 503  | `CAPABILITY_UNAVAILABLE` | `BETA_FEEDBACK_DISABLED`（开关关）/ `FEEDBACK_REPOSITORY_UNAVAILABLE`（无库或无 cursor 密钥）                             |

后台：404 `NOT_FOUND` / `FEEDBACK_NOT_FOUND`；422 `FEEDBACK_ADMIN_NOTE_TOO_LONG` / `FEEDBACK_ADMIN_NOTE_INVALID`（field `adminNote`）；400 空 body / 未知键 / 非枚举 status；503 `FEEDBACK_REPOSITORY_UNAVAILABLE`。

## 5. unavailable 与开关

- `BETA_FEEDBACK_ENABLED`（on|off，默认 on，其他值拒绝启动）。off：三条 App 路由一律 503 `BETA_FEEDBACK_DISABLED`（上传在读文件前就拒绝，不落任何对象）。后台三条路由**不受开关影响**（关掉入口后仍可处理存量反馈）。
- 没有数据库 / 没有 `V2_CURSOR_HMAC_SECRET`：503 `FEEDBACK_REPOSITORY_UNAVAILABLE`，绝不返回空列表冒充。
- 不新增 `/v2/meta/capabilities` 能力 ID（客户端由 dart-define 控制入口，且能力列表是严格解析的）。

## 6. 后台（主代理合同修正）

- 路径挂在现有 `adminApiPrefix`：`GET /admin/v1/feedback`、`GET /admin/v1/feedback/{feedbackId}`、`PATCH /admin/v1/feedback/{feedbackId}`。不开 `/v2/admin/*`（loop-admin 只反代 `/admin/v1`，会话 cookie `Path=/admin`）。
- 权限：读 = `console.read`（platform_admin、auditor）或 `launch.approve`（reviewer）；PATCH = `console.write`（platform_admin）或 `launch.approve`（reviewer）；testnet_acceptor 两者都没有 → 403。
- 列表 `{items, nextCursor}`，`status` / `category` 过滤，`limit` 1–100（默认 20），`cursor` 用后台会话密钥 HMAC 签名并绑定过滤条件；详情 `{feedback}`；PATCH `{feedback, audit: {auditId, seq, at}}`，`adminNote: null` 或空串清空。

## 7. 与 docs/52 的差异

- 后台路径由 `/v2/admin/feedback*` 改为 `/admin/v1/feedback*`（主代理已裁决）。
- 截图输出保持宽高比（见 §3），不是 512 方图；接口形状不变。
- App 响应严格按 docs/52 形状，不附加 `contractVersion`（与移动端并行编码的严格键集一致）。
