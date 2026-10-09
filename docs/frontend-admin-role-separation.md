# 运营后台分权（S128 / 决策 0109）—— loop-admin 对接合同

本文是 loop-admin 接入「平台端分权」的唯一依据：后台账号与角色、会话里的权限列表、账号管理、
发射项目（Hooks）审核与测试网验收。机器契约：`openapi/loop-admin.v1.json`（`pnpm openapi:generate`
生成）。决策与偏离见 `docs/decisions/0109-admin-role-separation.md`。旧接口（概览、设置、社区审核、
挖矿公式、MEME、审计）的请求/响应不变，见 `docs/admin-v1-api.md`；本文只写**新增与变化**。

项目端（项目资料、NFT 开售时间、收币地址、配置版本、项目钱包签名、部署进度）**不在后台**：
项目方在 App 内用 `/v2/launch/projects/{projectId}/hooks-config` 等接口（`docs/frontend-v2-hooks-launch-api.md`）。

## 0. 给 loop-admin 的变化清单

1. 登录 / `GET /session` 响应多了 `accountId`、`role`、`permissions`、`passwordChangeRequired`、
   `operatorUserId`。用 `permissions` 决定显示哪些菜单和按钮；**服务端每个请求都会再校验**，按钮
   藏不藏都不影响安全。
2. 新错误码 `PERMISSION_DENIED`（403，`category: "authorization"`）。所有受保护接口都可能返回，
   `detailsSafe.reasonCode` 说明原因（§6）。
3. `passwordChangeRequired: true` 时只能调用 `GET/DELETE /session` 与 `POST /session/password`，
   其它一律 403 `ADMIN_PASSWORD_CHANGE_REQUIRED` —— 登录后直接跳「设置新密码」页。
4. 新写接口（账号 3 个、审批、测试网验收）**必须**带 `Idempotency-Key`（小写 UUIDv4）。旧写接口
   仍然不带（照旧用 `updatedAt` 乐观锁）。
5. 审计行（`GET /audit`、概览 `recentAudit`）多一个字段 `actorAccountId`（UUID 或 null）。
6. 部署后旧 cookie（v1 格式）全部失效，所有人需要重新登录一次。

## 1. 基址、请求头、cookie

| 环境    | Base URL                              |
| ------- | ------------------------------------- |
| Dev     | `https://api-dev.quant-dinger.cc`     |
| Staging | `https://api-staging.quant-dinger.cc` |
| 本机    | `http://127.0.0.1:<PORT>`             |

| 头                | 何时                      | 值                                                                                                     |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Cookie`          | 除 `POST /session` 外全部 | `loop_admin_session=<原样转发>`                                                                        |
| `Content-Type`    | 有请求体的写接口          | `application/json`                                                                                     |
| `Idempotency-Key` | 本文 §3、§4 的 5 个写接口 | 小写 UUIDv4，例 `3f0c1f2e-8b7a-4c61-9d2e-5a4b3c2d1e0f`；每次**新操作**新生成，**重试同一操作**用同一个 |

- 不用 Privy Bearer，不用 `X-Loop-Contract-Version`。
- 所有响应 `Cache-Control: no-store`。
- cookie 规则同 `docs/admin-v1-api.md` §2（`Path=/admin; HttpOnly; SameSite=Strict`，12 小时）。
  新增：**账号被停用、密码被重置或本人改密后，该账号所有旧 cookie 立即 401**（不依赖进程内存，重启也不会复活）。

## 2. 角色与权限

| 权限 `permissions[]` | platform_admin 平台管理员 | reviewer 审核人 | testnet_acceptor 测试网验收人 | auditor 审计员 | 对应接口                                             |
| -------------------- | :-----------------------: | :-------------: | :---------------------------: | :------------: | ---------------------------------------------------- |
| `console.read`       |             ✓             |                 |                               |       ✓        | 概览、设置读、社区读、挖矿公式读、MEME 读            |
| `console.write`      |             ✓             |                 |                               |                | 设置写、社区审核、公式草稿/批准/撤回、MEME 下架/暂停 |
| `accounts.read`      |             ✓             |                 |                               |       ✓        | `GET /accounts`                                      |
| `accounts.manage`    |             ✓             |                 |                               |                | 建账号、停用、重置密码                               |
| `audit.read`         |             ✓             |        ✓        |               ✓               |       ✓        | `GET /audit`                                         |
| `launch.read`        |             ✓             |        ✓        |               ✓               |       ✓        | 发射项目列表 / 详情                                  |
| `launch.approve`     |                           |        ✓        |                               |                | 批准配置版本                                         |
| `testnet.read`       |             ✓             |                 |               ✓               |       ✓        | （仅供界面显示，暂无独立接口）                       |
| `testnet.accept`     |                           |                 |               ✓               |                | 记录测试网验收                                       |

要点：

- **平台管理员（包括环境变量里的 `ADMIN_USERNAME` 引导账号）不能批准、不能验收**；审核人不能验收；
  验收人不能批准。没有任何角色同时拥有「编辑 / 批准 / 验收」中的两项。
- 审核人、验收人账号绑定一个 LOOP 用户（`operatorUserId`）。批准 / 验收以这个用户的身份执行，
  服务端继续拦：该版本的编辑人（保存它的运营人员，或项目方自己保存的草稿的项目方）和项目方本人
  **不能批准**（`OPS_SELF_APPROVAL`），也**不能验收**（`OPS_SELF_ACCEPTANCE`）。
- 一个 LOOP 用户同一时间只能绑定一个有效账号（不能既是审核人又是验收人）。
- 环境变量引导账号：`accountId: null`、`role: "platform_admin"`；在后台里不能停用、不能重置、
  不能改密码（改环境变量）。`GET /accounts` 的 `bootstrap` 字段显示它。

## 3. 会话

### 3.1 `POST /admin/v1/session` 登录

先查后台账号，再查引导账号。被停用的账号与密码错误一样返回 401 `ADMIN_LOGIN_INVALID`。

请求：

```json
{ "username": "reviewer-alice", "password": "••••••••••••" }
```

200（同时 `Set-Cookie`）：

```json
{
  "actor": "reviewer-alice",
  "accountId": "6a1d0f6e-2c55-4d0b-9a1e-0f3c1b2a4d5e",
  "role": "reviewer",
  "permissions": ["audit.read", "launch.approve", "launch.read"],
  "passwordChangeRequired": false,
  "operatorUserId": "0b9f6c1a-7d2e-4f3a-8b5c-1d2e3f4a5b6c",
  "issuedAt": "2026-10-10T02:00:00.000Z",
  "expiresAt": "2026-10-10T14:00:00.000Z"
}
```

错误：400 `INVALID_REQUEST`、401 `ADMIN_LOGIN_INVALID`、423 `ADMIN_LOGIN_LOCKED`、
429 `ADMIN_LOGIN_BUSY`、503 `CAPABILITY_UNAVAILABLE`（`ADMIN_DATABASE_UNAVAILABLE`，查账号失败）、
503 `REQUEST_TIMEOUT`、500 `INTERNAL_ERROR`。锁定仍是**全进程全局**：任一账号连续 5 次失败，所有账号锁 15 分钟。

### 3.2 `GET /admin/v1/session`

200 与登录响应同形（无 `Set-Cookie`）。401 `ADMIN_SESSION_REQUIRED` → 回登录页。

### 3.3 `POST /admin/v1/session/password` 修改本人密码（新）

任何后台账号（含 `passwordChangeRequired: true` 的）都可调用；引导账号 409。

请求：

```json
{ "currentPassword": "初始密码", "newPassword": "至少12个字符的新密码" }
```

200：与登录响应同形，`passwordChangeRequired: false`，并 `Set-Cookie` 新 cookie（旧 cookie 立即失效，
后台要用新 cookie 覆盖）。

错误：401 `ADMIN_LOGIN_INVALID`（当前密码错）、409 `ADMIN_CONFLICT`
（`ADMIN_ACCOUNT_ENVIRONMENT` 引导账号；`ADMIN_UPDATED_AT_MISMATCH` 同时被管理员重置）、
422 `VALIDATION_FAILED`（`ADMIN_PASSWORD_INVALID`：长度 12–256、不含控制字符、不能与旧密码相同；
`detailsSafe.minimumLength`/`maximumLength`）、429 `ADMIN_LOGIN_BUSY`、401 `ADMIN_SESSION_REQUIRED`、
400、503、500。

### 3.4 `DELETE /admin/v1/session`

不变（204，清 cookie）。

## 4. 账号管理（platform_admin）

账号对象 `account`：

```json
{
  "accountId": "6a1d0f6e-2c55-4d0b-9a1e-0f3c1b2a4d5e",
  "username": "reviewer-alice",
  "role": "reviewer",
  "permissions": ["audit.read", "launch.approve", "launch.read"],
  "status": "active",
  "operatorUserId": "0b9f6c1a-7d2e-4f3a-8b5c-1d2e3f4a5b6c",
  "operator": {
    "enabled": true,
    "grants": [
      { "permission": "audit.read", "scope": "*" },
      { "permission": "launch.approve", "scope": "*" },
      { "permission": "launch.read", "scope": "*" }
    ]
  },
  "passwordChangeRequired": true,
  "credentialsChangedAt": "2026-10-10T02:00:00.000Z",
  "createdAt": "2026-10-10T02:00:00.000Z",
  "createdBy": "operator",
  "disabledAt": null,
  "disabledBy": null
}
```

- `operator` 是绑定 LOOP 用户的实时运营授权（`ops_operators` + `ops_grants`）；未绑定的角色为 `null`。
  `enabled: false` = 已撤销；`enabled: null` = 没有运营记录。`scope` 为 `*` 或一个项目 ID。
- 永远不返回密码或哈希。

写接口回执 `accountWrite`：

```json
{
  "account": { "…": "同上" },
  "changed": true,
  "replayed": false,
  "audit": { "auditId": "9d0e…", "seq": 812, "at": "2026-10-10T02:00:00.000Z" }
}
```

`replayed: true` 表示同一个 `Idempotency-Key` 之前已执行过（返回账号当前状态，`audit: null`）。

### 4.1 `GET /admin/v1/accounts`（`accounts.read`）

200：

```json
{
  "items": [{ "…": "account" }],
  "bootstrap": {
    "username": "operator",
    "role": "platform_admin",
    "source": "environment"
  }
}
```

最多 500 条，新建在前，无分页。错误：401、403、503 `ADMIN_DATABASE_UNAVAILABLE`、400、500。

### 4.2 `POST /admin/v1/accounts` 新建（`accounts.manage`，`Idempotency-Key` 必填）

```json
{
  "username": "reviewer-alice",
  "password": "初始密码至少12位",
  "role": "reviewer",
  "operatorUserId": "0b9f6c1a-7d2e-4f3a-8b5c-1d2e3f4a5b6c",
  "operatorLabel": "Alice（审核）",
  "projectIds": null
}
```

- `username`：`^[A-Za-z0-9._@-]{1,64}$`，大小写不敏感唯一，不能是引导账号名。
- `role`：`platform_admin | reviewer | testnet_acceptor | auditor`，建后不可改。
- `operatorUserId`：reviewer / testnet_acceptor **必填**（LOOP 用户 ID），其它角色**不许带**。
- `operatorLabel`：可选，默认用 username（≤ 80 字）。
- `projectIds`：可选；`null` = 全部项目；数组（1–20 个项目 ID）= 只授权这些项目（「按项目授权」）。
- 账号建好后 `passwordChangeRequired: true`，持有人首次登录必须改密码。

201 `accountWrite`（重放为 200）。错误：400 `INVALID_REQUEST`（缺/错 `Idempotency-Key`、字段格式）、
403、409 `ADMIN_CONFLICT`（`ADMIN_ACCOUNT_USERNAME_TAKEN`、`ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND`、
`ADMIN_IDEMPOTENCY_CONFLICT`）、422 `VALIDATION_FAILED`（`ADMIN_PASSWORD_INVALID`、
`ADMIN_ACCOUNT_OPERATOR_REQUIRED`、`ADMIN_ACCOUNT_OPERATOR_NOT_ALLOWED`、
`ADMIN_ACCOUNT_OPERATOR_USER_NOT_FOUND`、`ADMIN_ACCOUNT_PROJECT_NOT_FOUND`（带 `projectId`）、
`ADMIN_OPERATOR_LABEL_INVALID`）、429 `ADMIN_LOGIN_BUSY`、503、500。

### 4.3 `POST /admin/v1/accounts/{accountId}/disable` 停用（`accounts.manage`，`Idempotency-Key` 必填）

```json
{ "reasonCode": "left_team" }
```

停用不可恢复（需要时新建账号）；该账号所有会话立即失效；绑定的运营授权同时撤销
（`operator.enabled: false`）。已停用再停用 → 200 `changed: false`。

错误：403、404 `ADMIN_ACCOUNT_NOT_FOUND`、409（`ADMIN_ACCOUNT_SELF` 停用自己、
`ADMIN_IDEMPOTENCY_CONFLICT`）、422 `ADMIN_REASON_CODE_INVALID`、400、401、503、500。

### 4.4 `POST /admin/v1/accounts/{accountId}/reset-password` 重置密码（`accounts.manage`，`Idempotency-Key` 必填）

```json
{ "password": "新的初始密码至少12位" }
```

该账号所有会话立即失效，`passwordChangeRequired: true`。错误：403、404、
409（`ADMIN_ACCOUNT_DISABLED`、`ADMIN_ACCOUNT_SELF` 重置自己请用 §3.3、`ADMIN_IDEMPOTENCY_CONFLICT`）、
422 `ADMIN_PASSWORD_INVALID`、429、400、401、503、500。

## 5. 发射项目审核（Hooks）

### 5.1 `GET /admin/v1/launch/projects`（`launch.read`）

查询参数：`status`（`draft | awaiting_approval | approved | accepted | deploying`）、`limit`（1–100，默认 20）、
`cursor`（上一页的 `nextCursor`，必须与同一个 `status` 一起用）。

阶段 `stage` 取**最新配置版本**：有待执行部署任务 → `deploying`；有通过的测试网验收 → `accepted`；
已批准 → `approved`；未批准 → `awaiting_approval`；还没有任何配置版本 → `draft`。

200：

```json
{
  "items": [
    {
      "projectId": "1e7a9c55-0b3d-4f2a-9c1e-2b3c4d5e6f70",
      "name": "Project",
      "ticker": "MEME",
      "ownerUserId": "b0c084d3-21c8-46f9-bd62-1e69e09a3c53",
      "launchReviewStatus": "approved",
      "stage": "awaiting_approval",
      "latestConfigVersion": 2,
      "latestConfigHash": "0x352a30cf38a51245ff842f7146a641bd094ee440fb3303c1054fef3d26eb73b4",
      "latestEditedBy": {
        "kind": "owner",
        "userId": "b0c084d3-21c8-46f9-bd62-1e69e09a3c53"
      },
      "latestApproval": null,
      "latestAcceptanceOutcome": null,
      "activeDeploymentJobId": null,
      "createdAt": "2026-10-09T16:45:54.172Z",
      "updatedAt": "2026-10-09T16:45:54.172Z"
    }
  ],
  "nextCursor": null,
  "scope": "all"
}
```

- `scope: "projects"`：当前审核人 / 验收人只被授权了部分项目，列表只含这些项目。
- `launchReviewStatus` 是项目资料审核状态；只有 `approved` 的项目能被批准配置（否则 409 `OPS_LAUNCH_NOT_APPROVED`）。

错误：400（`status`/`limit`/`cursor` 不合法）、401、403（`ADMIN_ROLE_FORBIDDEN`；`OPS_FORBIDDEN`
= 绑定的运营授权已撤销或没有 `launch.read`）、503、500。

### 5.2 `GET /admin/v1/launch/projects/{projectId}`（`launch.read`）

200：

```json
{
  "project": { "…": "同列表项" },
  "versions": [
    {
      "version": 2,
      "templateVersion": "hooks_launch_v1",
      "configHash": "0x352a…73b4",
      "config": {
        "name": "Project",
        "ticker": "MEME",
        "logoAssetUrl": "https://example.com/logo.png",
        "description": "…",
        "links": ["https://example.com"],
        "nftSaleStartAt": "1900000000",
        "buybackRecipient": "0x3333333333333333333333333333333333333333",
        "templateHash": "0x4c5e…51ca",
        "fixedEconomics": {
          "nftPriceUsd1Raw": "100000000000000000000",
          "lpFee": 2500,
          "…": "…"
        }
      },
      "editedBy": { "kind": "operator", "userId": "…" },
      "createdAt": "2026-10-09T16:45:54.175Z",
      "approval": {
        "approverUserId": "5cbaf2f8-19dd-40da-8030-63f86d93a731",
        "configHash": "0x352a…73b4",
        "reason": "Independent hash review",
        "approvedAt": "2026-10-09T16:45:54.362Z"
      }
    }
  ],
  "testnetAcceptances": [
    {
      "acceptanceId": "…",
      "configVersion": 2,
      "chainId": 97,
      "configHash": "0x352a…73b4",
      "contractManifestHash": "0xcdcd…cdcd",
      "checklistVersion": "hooks-testnet-v1",
      "outcome": "passed",
      "evidence": [{ "label": "deploy tx", "uri": "0xefef…efef" }],
      "acceptorUserId": "…",
      "reason": "Testnet checklist passed",
      "createdAt": "2026-10-09T17:00:00.000Z"
    }
  ],
  "deploymentTasks": [
    {
      "jobId": "72c6dc5e-7998-4e1c-ae25-39b615aa3828",
      "configVersion": 1,
      "status": "awaiting_executor",
      "chainId": 97,
      "factoryAddress": "0x1111111111111111111111111111111111111111",
      "projectOwner": "0x629094d581014a04bfae5cc8862dd16c00000000",
      "ownerNonce": "7",
      "bindingHash": "0x7b98…5914",
      "predictedMemeAddress": "0xabababababababababababababababababab6666",
      "predictedHookAddress": "0xabababababababababababababababababab20cc",
      "authorizationCount": 1,
      "latestAuthorizationAt": "2026-10-09T16:45:54.370Z",
      "createdAt": "2026-10-09T16:45:54.369Z"
    }
  ]
}
```

- `versions` 新版本在前（最多 200）；`editedBy.kind`：`owner` = 项目方在 App 保存，`operator` = 运营编辑保存。
- `buybackRecipient` 即「收币地址」，`nftSaleStartAt` 即 NFT 开售时间（Unix 秒字符串）。金额均为十进制字符串（`…Raw`）。
- `deploymentTasks` 里的 `predictedMemeAddress` / `predictedHookAddress` 是 EIP-712 签名绑定的预测地址。
  **签名本身永不返回**。
- 「可批准」= `project.latestConfigVersion` 存在、该版本 `approval` 为 null、`launchReviewStatus` 为 `approved`。
  「可验收」= 最新版本已批准。按钮显示仍须以服务端结果为准。

错误：401、403、404（`ADMIN_LAUNCH_PROJECT_NOT_FOUND`，含不在授权范围内的项目）、400、503、500。

### 5.3 `POST /admin/v1/launch/projects/{projectId}/versions/{version}/approve`（`launch.approve`，仅 reviewer，`Idempotency-Key` 必填）

```json
{
  "configHash": "0x352a30cf38a51245ff842f7146a641bd094ee440fb3303c1054fef3d26eb73b4",
  "reason": "逐项核对哈希与字段，同意"
}
```

- `version` 必须是**最新**版本，`configHash` 必须与该版本一致（防止批准了被改过的内容）。
- `reason` 1–500 字。

200：

```json
{
  "operationId": "3f0c1f2e-8b7a-4c61-9d2e-5a4b3c2d1e0f",
  "replayed": false,
  "approval": {
    "projectId": "1e7a9c55-0b3d-4f2a-9c1e-2b3c4d5e6f70",
    "configVersion": 2,
    "configHash": "0x352a…73b4",
    "approverUserId": "0b9f6c1a-7d2e-4f3a-8b5c-1d2e3f4a5b6c",
    "reason": "逐项核对哈希与字段，同意",
    "approvedAt": "2026-10-10T02:10:00.000Z"
  },
  "audit": { "auditId": "…", "seq": 820, "at": "2026-10-10T02:10:00.000Z" }
}
```

错误：

| HTTP | code                     | reasonCode                                                                                                          | 界面提示                             |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 400  | `INVALID_REQUEST`        | — / `ADMIN_IDEMPOTENCY_KEY_REQUIRED`                                                                                | 请求格式错 / 缺幂等键                |
| 403  | `PERMISSION_DENIED`      | `ADMIN_ROLE_FORBIDDEN`                                                                                              | 当前角色不能批准                     |
| 403  | `PERMISSION_DENIED`      | `OPS_SELF_APPROVAL`                                                                                                 | 你是该版本编辑人或项目方，不能自批   |
| 403  | `PERMISSION_DENIED`      | `OPS_FORBIDDEN`                                                                                                     | 运营授权已撤销或不含该项目           |
| 404  | `NOT_FOUND`              | `OPS_NOT_FOUND` / `ADMIN_LAUNCH_PROJECT_NOT_FOUND`                                                                  | 项目或版本不存在                     |
| 409  | `ADMIN_CONFLICT`         | `OPS_VERSION_CONFLICT`                                                                                              | 版本已过时或哈希不符，刷新详情       |
| 409  | `ADMIN_CONFLICT`         | `OPS_LAUNCH_NOT_APPROVED`                                                                                           | 项目资料尚未通过审核                 |
| 409  | `ADMIN_CONFLICT`         | `OPS_IDEMPOTENCY_CONFLICT`                                                                                          | 幂等键被另一请求用过，换新键         |
| 422  | `VALIDATION_FAILED`      | `ADMIN_REASON_TEXT_INVALID` / `OPS_INVALID_COMMAND`                                                                 | 理由为空或过长                       |
| 503  | `CAPABILITY_UNAVAILABLE` | `ADMIN_AUDIT_UNAVAILABLE` / `ADMIN_DATABASE_UNAVAILABLE` / `HOOKS_LAUNCH_REVIEW_UNAVAILABLE` / `OPS_COMMAND_FAILED` | 暂不可用，稍后用**同一个**幂等键重试 |

### 5.4 `POST /admin/v1/launch/projects/{projectId}/testnet-acceptance`（`testnet.accept`，仅 testnet_acceptor，`Idempotency-Key` 必填）

```json
{
  "configVersion": 2,
  "configHash": "0x352a30cf38a51245ff842f7146a641bd094ee440fb3303c1054fef3d26eb73b4",
  "contractManifestHash": "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  "checklistVersion": "hooks-testnet-v1",
  "outcome": "passed",
  "evidence": [
    {
      "label": "部署交易",
      "uri": "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef"
    },
    { "label": "检查清单截图", "uri": "https://example.com/evidence/1.png" }
  ],
  "reason": "BSC Testnet 检查清单全部通过"
}
```

- `outcome`：`passed | failed | incomplete`；`evidence` 1–50 条，`uri` 为 https 链接或 0x 交易哈希。
- 只记录 BSC Testnet（chainId 97）；验收 ID = `Idempotency-Key`。

200：

```json
{
  "operationId": "…",
  "replayed": false,
  "acceptance": {
    "acceptanceId": "…",
    "projectId": "…",
    "configVersion": 2,
    "chainId": 97,
    "configHash": "0x352a…73b4",
    "contractManifestHash": "0xcdcd…cdcd",
    "checklistVersion": "hooks-testnet-v1",
    "outcome": "passed",
    "evidence": [{ "label": "部署交易", "uri": "0xefef…efef" }],
    "acceptorUserId": "…",
    "reason": "BSC Testnet 检查清单全部通过",
    "createdAt": "2026-10-10T03:00:00.000Z"
  },
  "audit": { "auditId": "…", "seq": 830, "at": "2026-10-10T03:00:00.000Z" }
}
```

错误同 §5.3，另有：403 `OPS_SELF_ACCEPTANCE`（你是该版本编辑人或项目方）、409
`OPS_LAUNCH_CONFIG_NOT_APPROVED`（该版本未批准或哈希不符）。

## 6. 错误体与全部错误码

错误体仍是七字段：`code, category, retryable, userMessageKey, correlationId, detailsSafe, providerReferenceSafe`。

| code                      | HTTP | category       | 本批新增的 reasonCode                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED`（新） | 403  | authorization  | `ADMIN_ROLE_FORBIDDEN`（+`permission`）、`ADMIN_PASSWORD_CHANGE_REQUIRED`、`OPS_FORBIDDEN`、`OPS_SELF_APPROVAL`、`OPS_SELF_ACCEPTANCE`                                                                                                                                                                                          |
| `ADMIN_SESSION_REQUIRED`  | 401  | authentication | — （账号停用 / 改密 / 重置后旧 cookie 也是它）                                                                                                                                                                                                                                                                                  |
| `ADMIN_LOGIN_INVALID`     | 401  | authentication | — （也用于改密时当前密码错）                                                                                                                                                                                                                                                                                                    |
| `ADMIN_LOGIN_LOCKED`      | 423  | rateLimit      | —                                                                                                                                                                                                                                                                                                                               |
| `ADMIN_LOGIN_BUSY`        | 429  | rateLimit      | — （也用于建账号 / 重置时密码哈希繁忙，`Retry-After: 1`）                                                                                                                                                                                                                                                                       |
| `ADMIN_CONFLICT`          | 409  | conflict       | `ADMIN_IDEMPOTENCY_CONFLICT`、`ADMIN_ACCOUNT_USERNAME_TAKEN`、`ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND`、`ADMIN_ACCOUNT_DISABLED`、`ADMIN_ACCOUNT_SELF`、`ADMIN_ACCOUNT_ENVIRONMENT`、`ADMIN_UPDATED_AT_MISMATCH`、`OPS_VERSION_CONFLICT`、`OPS_LAUNCH_NOT_APPROVED`、`OPS_LAUNCH_CONFIG_NOT_APPROVED`、`OPS_IDEMPOTENCY_CONFLICT` |
| `INVALID_REQUEST`         | 400  | validation     | `ADMIN_IDEMPOTENCY_KEY_REQUIRED`（或无 reasonCode：请求头/体格式由 schema 拒绝）                                                                                                                                                                                                                                                |
| `VALIDATION_FAILED`       | 422  | validation     | `ADMIN_PASSWORD_INVALID`、`ADMIN_ACCOUNT_OPERATOR_REQUIRED`、`ADMIN_ACCOUNT_OPERATOR_NOT_ALLOWED`、`ADMIN_ACCOUNT_OPERATOR_USER_NOT_FOUND`、`ADMIN_ACCOUNT_PROJECT_NOT_FOUND`、`ADMIN_OPERATOR_LABEL_INVALID`、`ADMIN_REASON_CODE_INVALID`、`ADMIN_REASON_TEXT_INVALID`、`OPS_INVALID_COMMAND`、`OPS_INVALID_LAUNCH_CONFIG`     |
| `NOT_FOUND`               | 404  | validation     | `ADMIN_ACCOUNT_NOT_FOUND`、`ADMIN_LAUNCH_PROJECT_NOT_FOUND`、`OPS_NOT_FOUND`                                                                                                                                                                                                                                                    |
| `CAPABILITY_UNAVAILABLE`  | 503  | availability   | `ADMIN_DATABASE_UNAVAILABLE`、`ADMIN_AUDIT_UNAVAILABLE`、`HOOKS_LAUNCH_REVIEW_UNAVAILABLE`、`OPS_COMMAND_FAILED`                                                                                                                                                                                                                |
| `REQUEST_TIMEOUT`         | 503  | availability   | —                                                                                                                                                                                                                                                                                                                               |
| `INTERNAL_ERROR`          | 500  | internal       | —                                                                                                                                                                                                                                                                                                                               |

## 7. 不可用时的行为

| 情况                             | 表现                                                                                           | 后台应显示                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| API 没有数据库                   | 只有引导账号能登录；`/accounts`、`/launch/*` 503 `ADMIN_DATABASE_UNAVAILABLE`；账号 cookie 401 | 「账号与发射审核暂不可用」               |
| 登录时查账号失败                 | 503 `ADMIN_DATABASE_UNAVAILABLE`（不计失败次数）                                               | 「稍后再试」                             |
| 审计写不进去                     | 批准 / 验收 503 `ADMIN_AUDIT_UNAVAILABLE`，**什么都没执行**                                    | 「暂不可用」，可用同一幂等键重试         |
| 审核服务未装配                   | 503 `HOOKS_LAUNCH_REVIEW_UNAVAILABLE`                                                          | 同上                                     |
| 运营授权被 CLI 撤销 / 不含该项目 | 403 `OPS_FORBIDDEN`                                                                            | 「你的运营授权已失效，请联系平台管理员」 |
| 首次登录 / 被重置                | 403 `ADMIN_PASSWORD_CHANGE_REQUIRED`                                                           | 跳到改密页                               |

`HOOKS_LAUNCH_ENABLED` 开关**不影响**后台审核（只管 App 端签名与提交部署任务）。

## 8. 审计

- `admin_audit_log`（`GET /audit` 可查）新增 action：`account.create`、`account.disable`、
  `account.reset_password`、`account.password_change`、`launch.config.approve.requested|decided|failed`、
  `testnet.acceptance.record.requested|decided|failed`；`session.login` 的 `after` 多 `role`。
  `targetType`：`admin_account` 或 `launch_project`。
- 绑定 / 撤销运营授权同时写 `ops_audit`（`operator.provision` / `operator.revoke`），批准与验收由审核服务写
  `ops_audit`（成功 `succeeded`，被拒 `rejected`）。后台暂无读 `ops_audit` 的接口。
