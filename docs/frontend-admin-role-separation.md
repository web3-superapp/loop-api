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

| 权限 `permissions[]` | platform_admin 平台管理员 | reviewer 审核人 | testnet_acceptor 测试网验收人 | auditor 审计员 | 对应接口                                         |
| -------------------- | :-----------------------: | :-------------: | :---------------------------: | :------------: | ------------------------------------------------ |
| `console.read`       |             ✓             |                 |                               |       ✓        | 概览、设置读、社区读、挖矿公式读、MEME 读        |
| `console.write`      |             ✓             |                 |                               |                | 设置写、社区审核、公式草稿/撤回、MEME 下架/暂停  |
| `accounts.read`      |             ✓             |                 |                               |       ✓        | `GET /accounts`                                  |
| `accounts.manage`    |             ✓             |                 |                               |                | 建账号、停用、重置密码                           |
| `audit.read`         |             ✓             |        ✓        |               ✓               |       ✓        | `GET /audit`                                     |
| `launch.read`        |             ✓             |        ✓        |               ✓               |       ✓        | 发射项目列表 / 详情                              |
| `launch.approve`     |                           |        ✓        |                               |                | 批准配置版本                                     |
| `testnet.read`       |             ✓             |                 |               ✓               |       ✓        | （仅供界面显示，暂无独立接口）                   |
| `testnet.accept`     |                           |                 |               ✓               |                | 记录测试网验收                                   |
| `formula.approve`    |                           |        ✓        |                               |                | 批准挖矿公式草稿、读公式列表（S129 / 决策 0110） |

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
  "permissions": [
    "audit.read",
    "formula.approve",
    "launch.approve",
    "launch.read"
  ],
  "passwordChangeRequired": false,
  "operatorUserId": "0b9f6c1a-7d2e-4f3a-8b5c-1d2e3f4a5b6c",
  "issuedAt": "2026-10-10T02:00:00.000Z",
  "expiresAt": "2026-10-10T14:00:00.000Z"
}
```

错误：400 `INVALID_REQUEST`、401 `ADMIN_LOGIN_INVALID`、423 `ADMIN_LOGIN_LOCKED`、
429 `ADMIN_LOGIN_BUSY`、503 `CAPABILITY_UNAVAILABLE`（`ADMIN_DATABASE_UNAVAILABLE`，查账号失败）、
503 `REQUEST_TIMEOUT`、500 `INTERNAL_ERROR`。锁定自 S129（决策 0110）起**按用户名**与**按来源 IP**
分别计数，见 §9.2。

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
          "chainId": "56",
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
  ],
  "deploymentChainId": 97
}
```

- `deploymentChainId`（决策 0117，只读，整数 `56 | 97`）：本 API 实际部署 Hooks 发射的链，即服务端
  `LAUNCH_CHAIN_ID`（Development / 测试网为 97）。**`versions[].config.fixedEconomics.chainId` 是模板值
  （恒为 `"56"`，参与 configHash，不可编辑），不是部署链；部署链以 `LAUNCH_CHAIN_ID` 为准。** 后台在
  经济参数旁展示时请标注「模板值 56，部署链见 deploymentChainId」，不要把 56 渲染成「部署到 BSC 主网」。
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

| code                      | HTTP | category       | 本批新增的 reasonCode                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED`（新） | 403  | authorization  | `ADMIN_ROLE_FORBIDDEN`（+`permission`）、`ADMIN_PASSWORD_CHANGE_REQUIRED`、`OPS_FORBIDDEN`、`OPS_SELF_APPROVAL`、`OPS_SELF_ACCEPTANCE`、`ADMIN_FORMULA_SELF_APPROVAL`（S129）                                                                                                                                                                                                 |
| `ADMIN_SESSION_REQUIRED`  | 401  | authentication | — （账号停用 / 改密 / 重置后旧 cookie 也是它）                                                                                                                                                                                                                                                                                                                                |
| `ADMIN_LOGIN_INVALID`     | 401  | authentication | — （也用于改密时当前密码错）                                                                                                                                                                                                                                                                                                                                                  |
| `ADMIN_LOGIN_LOCKED`      | 423  | rateLimit      | — （S129 起 `detailsSafe` = `{scope: "username" \| "ip", retryAfterSeconds}`）                                                                                                                                                                                                                                                                                                |
| `ADMIN_LOGIN_BUSY`        | 429  | rateLimit      | — （也用于建账号 / 重置时密码哈希繁忙，`Retry-After: 1`）                                                                                                                                                                                                                                                                                                                     |
| `ADMIN_CONFLICT`          | 409  | conflict       | `ADMIN_IDEMPOTENCY_CONFLICT`、`ADMIN_ACCOUNT_USERNAME_TAKEN`、`ADMIN_ACCOUNT_OPERATOR_ALREADY_BOUND`、`ADMIN_ACCOUNT_DISABLED`、`ADMIN_ACCOUNT_SELF`、`ADMIN_ACCOUNT_ENVIRONMENT`、`ADMIN_UPDATED_AT_MISMATCH`、`OPS_VERSION_CONFLICT`、`OPS_LAUNCH_NOT_APPROVED`、`OPS_LAUNCH_CONFIG_NOT_APPROVED`、`OPS_IDEMPOTENCY_CONFLICT`、`ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`（S129） |
| `INVALID_REQUEST`         | 400  | validation     | `ADMIN_IDEMPOTENCY_KEY_REQUIRED`（或无 reasonCode：请求头/体格式由 schema 拒绝）                                                                                                                                                                                                                                                                                              |
| `VALIDATION_FAILED`       | 422  | validation     | `ADMIN_PASSWORD_INVALID`、`ADMIN_ACCOUNT_OPERATOR_REQUIRED`、`ADMIN_ACCOUNT_OPERATOR_NOT_ALLOWED`、`ADMIN_ACCOUNT_OPERATOR_USER_NOT_FOUND`、`ADMIN_ACCOUNT_PROJECT_NOT_FOUND`、`ADMIN_OPERATOR_LABEL_INVALID`、`ADMIN_REASON_CODE_INVALID`、`ADMIN_REASON_TEXT_INVALID`、`OPS_INVALID_COMMAND`、`OPS_INVALID_LAUNCH_CONFIG`                                                   |
| `NOT_FOUND`               | 404  | validation     | `ADMIN_ACCOUNT_NOT_FOUND`、`ADMIN_LAUNCH_PROJECT_NOT_FOUND`、`OPS_NOT_FOUND`                                                                                                                                                                                                                                                                                                  |
| `CAPABILITY_UNAVAILABLE`  | 503  | availability   | `ADMIN_DATABASE_UNAVAILABLE`、`ADMIN_AUDIT_UNAVAILABLE`、`HOOKS_LAUNCH_REVIEW_UNAVAILABLE`、`OPS_COMMAND_FAILED`                                                                                                                                                                                                                                                              |
| `REQUEST_TIMEOUT`         | 503  | availability   | —                                                                                                                                                                                                                                                                                                                                                                             |
| `INTERNAL_ERROR`          | 500  | internal       | —                                                                                                                                                                                                                                                                                                                                                                             |

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

## 9. S129 变更（决策 0110）：公式审批分权 + 登录按用户名锁定

本节是 S128 合同的增补；与前文冲突时以本节为准。机器契约已重新生成（`openapi/loop-admin.v1.json`）。

### 9.0 给 loop-admin 的改动清单

1. **「批准公式」按钮移到 reviewer 视图**：显示条件改为 `permissions` 含 `formula.approve`
   （只有 reviewer 有）。platform_admin 视图（含 `ADMIN_USERNAME` 引导账号）**隐藏**批准按钮；
   platform_admin 仍保留「新建草稿」（= 提交审批）与「撤回草稿」（`console.write`）。
2. reviewer 视图新增「挖矿公式」页（只读列表 + 批准按钮）：`GET /admin/v1/mining/formula-versions`
   现在接受 `console.read` **或** `formula.approve`。reviewer 没有 `console.read`，其它旧菜单
   （概览、设置、社区、MEME）对 reviewer 仍然 403，不要显示。
3. 公式版本对象多两个字段 `draftAuthor`、`approvedBy`（§9.1），列表与草稿 / 批准 / 撤回回执里都有。
   当 `draftAuthor === null` 或 `draftAuthor.accountId === 当前会话 accountId` 时，批准按钮置灰并提示原因；
   服务端同样会拒绝（隐藏只是体验）。
4. 批准公式新增错误：403 `PERMISSION_DENIED` + `ADMIN_FORMULA_SELF_APPROVAL`、409 `ADMIN_CONFLICT` +
   `ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`、503 `ADMIN_AUDIT_UNAVAILABLE`（§9.1）。
5. 登录 423 `ADMIN_LOGIN_LOCKED` 的 `detailsSafe` 多了 `scope`（`username` / `ip`），文案按 scope 区分
   （§9.2）；一个账号被锁不再影响其它账号登录。
6. 审计新 action：`mining.formula.approve.requested` / `.failed`、`session.login_locked`；
   `session.login_failed` 的 `after` 字段扩充（§9.3）。审计页筛选下拉要加上。
7. 写接口的 `Idempotency-Key` 约定不变：公式批准仍**不带**该头（与 S119 起一致），重复批准会得到
   409 `ADMIN_FORMULA_STATE_INVALID`。

### 9.1 挖矿公式审批

权限：

| 操作                                           | 接口                                                  | 权限                                | 角色                              |
| ---------------------------------------------- | ----------------------------------------------------- | ----------------------------------- | --------------------------------- |
| 读列表                                         | `GET /admin/v1/mining/formula-versions`               | `console.read` 或 `formula.approve` | platform_admin、auditor、reviewer |
| 新建草稿（= 提交审批，保存人记为 draftAuthor） | `POST /admin/v1/mining/formula-versions`              | `console.write`                     | platform_admin                    |
| 撤回草稿                                       | `POST /admin/v1/mining/formula-versions/{v}/withdraw` | `console.write`                     | platform_admin                    |
| 批准草稿                                       | `POST /admin/v1/mining/formula-versions/{v}/approve`  | `formula.approve`                   | **reviewer**                      |

公式版本对象新增字段（其余同 `docs/admin-v1-api.md` §5.6）：

```json
{
  "configVersion": "miningFormulaV3",
  "status": "approved",
  "…": "…",
  "draftAuthor": {
    "kind": "admin_account",
    "username": "ops-alice",
    "accountId": "0b6f0c1a-7d2e-4f3a-8b5c-1d2e3f4a5b6c"
  },
  "approvedBy": {
    "username": "reviewer-bob",
    "accountId": "6a1d0f6e-2c55-4d0b-9a1e-0f3c1b2a4d5e"
  }
}
```

- `draftAuthor.kind`：`admin_account`（后台账号，带 `accountId`）或 `admin_bootstrap`（`ADMIN_USERNAME`
  引导账号，`accountId: null`）。`draftAuthor: null` = 保存人未知（S129 之前保存的草稿或脚本建的版本）。
- `approvedBy`：后台批准该版本的 reviewer；草稿、脚本批准、旧版本为 `null`。
- 两个字段写入后不可改（数据库触发器）。

批准规则与错误（`POST …/{configVersion}/approve`，无请求体）：

| 情况                     | HTTP | code / reasonCode                                                   | 后台应显示                                                 |
| ------------------------ | ---- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| 角色无 `formula.approve` | 403  | `PERMISSION_DENIED` / `ADMIN_ROLE_FORBIDDEN`（`permission`）        | 不应出现（按钮已隐藏）                                     |
| 批准人就是草稿保存人     | 403  | `PERMISSION_DENIED` / `ADMIN_FORMULA_SELF_APPROVAL`                 | 「不能批准自己保存的草稿」                                 |
| 草稿保存人未知           | 409  | `ADMIN_CONFLICT` / `ADMIN_FORMULA_DRAFT_AUTHOR_UNKNOWN`             | 「该草稿缺少保存人记录，请平台管理员以它为基版本重新保存」 |
| 不是草稿                 | 409  | `ADMIN_CONFLICT` / `ADMIN_FORMULA_STATE_INVALID`（`status`）        | 刷新列表                                                   |
| 草稿不存在               | 404  | `NOT_FOUND` / `ADMIN_FORMULA_VERSION_NOT_FOUND`                     | 刷新列表                                                   |
| 社区权重校验失败         | 422  | `VALIDATION_FAILED` / `ADMIN_FORMULA_COMMUNITY_*`                   | 原文案                                                     |
| 审计意图行写不进去       | 503  | `CAPABILITY_UNAVAILABLE` / `ADMIN_AUDIT_UNAVAILABLE`                | 「暂不可用，稍后重试」（什么都没批准）                     |
| `NODE_ENV=production`    | 503  | `CAPABILITY_UNAVAILABLE` / `MINING_APPROVE_FORBIDDEN_IN_PRODUCTION` | 按钮置灰（列表 `approval.available: false`）               |
| 数据库不可用             | 503  | `CAPABILITY_UNAVAILABLE` / `ADMIN_DATABASE_UNAVAILABLE`             | 「暂不可用」                                               |

200 回执不变：`{ "version": FormulaVersion, "retiredVersion": "…" | null, "audit": {auditId, seq, at} }`，
`version.approvedBy` 是当前 reviewer。

### 9.2 登录锁定

| 维度                   | 规则（默认值，可用环境变量调）                                 | 423 `detailsSafe`                                 |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| 用户名（不分大小写）   | 连续 5 次失败锁该用户名 15 分钟；成功登录清零                  | `{"scope": "username", "retryAfterSeconds": 900}` |
| 来源 IP（IPv6 按 /64） | 15 分钟窗口内 50 次失败锁该 IP 15 分钟；成功登录不清零 IP 计数 | `{"scope": "ip", "retryAfterSeconds": 900}`       |

- 两个维度同时锁时返回剩余时间较长的那个（相同时为 `username`）。`Retry-After` 头同 `retryAfterSeconds`。
- 锁定期内正确密码也是 423；一个用户名被锁**不影响**其它用户名（同一 IP 未达上限时）。
- 计数在数据库，多实例共享、重启不清零。数据库不可用时登录 503 `ADMIN_DATABASE_UNAVAILABLE`（不校验密码）。
- 并发登录仍是每实例同一时刻只校验一次，其它 429 `ADMIN_LOGIN_BUSY`（不计失败）。
- 建议文案：`username` →「该账号登录失败次数过多，请 N 分钟后再试」；`ip` →「当前网络登录失败次数过多，请 N 分钟后再试」。

示例：

```json
{
  "code": "ADMIN_LOGIN_LOCKED",
  "category": "rateLimit",
  "retryable": true,
  "userMessageKey": "errors.admin.loginLocked",
  "correlationId": "2f4b1c9e-6a7d-4e3f-9b2c-1d0e8f7a6b5c",
  "detailsSafe": { "scope": "username", "retryAfterSeconds": 900 },
  "providerReferenceSafe": null
}
```

### 9.3 审计

| action                             | targetType               | `after`                                                                                                                           |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `mining.formula.approve.requested` | `mining_formula_version` | `{configVersion}`；批准前写，写不进去则不批准                                                                                     |
| `mining.formula.approve`           | `mining_formula_version` | 原字段 + `draftAuthor`、`approvedBy`、`requestedAuditId`（与批准同一事务）                                                        |
| `mining.formula.approve.failed`    | `mining_formula_version` | `{reasonCode, requestedAuditId}`                                                                                                  |
| `session.login_failed`（扩充）     | `session`                | `locked`、`lockScope`、`username`（仅已存在账号或引导账号，否则 null）、`accountId`、`sourceIp`、`usernameFailures`、`ipFailures` |
| `session.login_locked`（新）       | `session`                | `scope`、`retryAfterSeconds`、`failures`、`username`、`accountId`、`sourceIp`；每次开始锁定写一行                                 |

所有这些行的 `actorAccountId`：批准相关为 reviewer 账号；登录失败 / 锁定为 null（actor `anonymous`）。
锁定期内被直接拒绝的登录不写审计（避免刷屏），锁定开始那一次写 `session.login_locked`。

## 10. S130 变更（决策 0111）：解锁账号、停用即停运营、CLI 审批留痕

机器契约：`openapi/loop-admin.v1.json`（新增 `unlockAdminAccount`，共 30 个操作）。决策与偏离见
`docs/decisions/0111-admin-followups.md`。Base URL、cookie、错误体七字段同 §1 / §6，无新请求头。

### 10.0 给 loop-admin 的改动清单

1. 账号对象（`GET /accounts` 的 `items[]`，以及所有账号写接口回执里的 `account`）新增两个**只读**字段：
   `locked: boolean`、`lockedUntil: string | null`（ISO 时间，用户名被锁到何时；未锁为 `null`）。
   列表可显示「已锁定，至 HH:mm」。只反映**用户名**锁，不反映 IP 锁。
2. 账号列表每行加「解锁」按钮：**只在 `locked: true` 且 `status: "active"` 时显示**，且只对有
   `accounts.manage` 的会话（platform_admin）显示。点击后弹窗选原因（`reasonCode`），调 §10.1。
   成功后用回执里的 `account` 替换该行（`locked: false`）。`bootstrap`（环境变量引导账号）那一行
   **不显示**解锁按钮（它没有 `accountId`，服务端也会 409）。
3. 挖矿公式批准可能多两个 403 原因（§10.3），文案见下表。
4. 停用接口回执与语义不变；说明文字可补一句「停用后该人员的发射审核与公式审批权限同时失效」。

### 10.1 `POST /admin/v1/accounts/{accountId}/unlock` 解锁（`accounts.manage`，`Idempotency-Key` 必填）

请求：

```http
POST /admin/v1/accounts/6a1d0f6e-2c55-4d0b-9a1e-0f3c1b2a4d5e/unlock
Cookie: loop_admin_session=…
Idempotency-Key: 3f2c9a7e-1b4d-4e8f-9a6c-2d1e0f3b4a5c
Content-Type: application/json

{ "reasonCode": "identity_verified" }
```

- `reasonCode`：`^[a-z][a-z0-9_]{0,63}$`，必填，写进审计（建议选项：`identity_verified`
  「已核实本人」、`password_reset_done`「已重置密码」、`false_alarm`「误锁」）。
- 效果：删除该账号**用户名**的失败计数与锁（`admin_login_attempts` 的 username 行）；**不清 IP 计数**
  （同一网络失败过多导致的 IP 锁仍按 15 分钟自然解除）。解锁后持有人可立即用正确密码登录。

200 回执（`accountWrite`）：

```json
{
  "account": {
    "accountId": "6a1d0f6e-2c55-4d0b-9a1e-0f3c1b2a4d5e",
    "username": "reviewer-alice",
    "role": "reviewer",
    "permissions": [
      "audit.read",
      "formula.approve",
      "launch.approve",
      "launch.read"
    ],
    "status": "active",
    "operatorUserId": "0b9f6c1a-7d2e-4f3a-8b5c-1d2e3f4a5b6c",
    "operator": {
      "enabled": true,
      "grants": [{ "permission": "launch.read", "scope": "*" }]
    },
    "locked": false,
    "lockedUntil": null,
    "passwordChangeRequired": false,
    "credentialsChangedAt": "2026-10-10T02:00:00.000Z",
    "createdAt": "2026-10-10T02:00:00.000Z",
    "createdBy": "operator",
    "disabledAt": null,
    "disabledBy": null
  },
  "changed": true,
  "replayed": false,
  "audit": {
    "auditId": "1c7e5a2b-3d4f-4a6b-8c9d-0e1f2a3b4c5d",
    "seq": 913,
    "at": "2026-10-10T03:00:00.000Z"
  }
}
```

- 没有可清的记录（已过期或从未失败）→ 200 `changed: false`、`audit: null`。
- 同一 `Idempotency-Key` 原样重放 → 200 `replayed: true`、`changed: false`、`audit: null`，`account` 为当前状态。

错误：

| HTTP | code                     | `detailsSafe.reasonCode`                                                 | 何时 / 后台应显示                                                                         |
| ---- | ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`        | `ADMIN_IDEMPOTENCY_KEY_REQUIRED` 或无                                    | 缺/错 `Idempotency-Key`；`reasonCode` 格式不对                                            |
| 401  | `ADMIN_SESSION_REQUIRED` | —                                                                        | 会话失效 → 回登录页                                                                       |
| 403  | `PERMISSION_DENIED`      | `ADMIN_ROLE_FORBIDDEN`（`permission`）、`ADMIN_PASSWORD_CHANGE_REQUIRED` | 非 platform_admin（按钮应已隐藏）                                                         |
| 404  | `NOT_FOUND`              | `ADMIN_ACCOUNT_NOT_FOUND`                                                | 刷新列表                                                                                  |
| 409  | `ADMIN_CONFLICT`         | `ADMIN_ACCOUNT_ENVIRONMENT`                                              | 目标是引导账号（路径 `bootstrap` 或其用户名）：「环境账号不能在后台解锁，请等待 15 分钟」 |
| 409  | `ADMIN_CONFLICT`         | `ADMIN_ACCOUNT_DISABLED`                                                 | 账号已停用（不可恢复）                                                                    |
| 409  | `ADMIN_CONFLICT`         | `ADMIN_IDEMPOTENCY_CONFLICT`                                             | 同一个 key 用于不同请求 → 换新 key 重试                                                   |
| 503  | `CAPABILITY_UNAVAILABLE` | `ADMIN_DATABASE_UNAVAILABLE`                                             | 「暂不可用，稍后重试」（什么都没改）                                                      |
| 500  | `INTERNAL_ERROR`         | —                                                                        | 通用错误                                                                                  |

### 10.2 停用账号同时停用运营人员

`POST /accounts/{accountId}/disable` 的请求与回执不变。对 reviewer / testnet_acceptor：同一事务内
`ops_operators.enabled = false`（回执 `account.operator.enabled: false`），审计 `account.disable` 的
`after` 多 `operatorEnabledBefore`（停用前是否启用）与 `operatorEnabled`。之后该人员的发射审核
（403 `OPS_FORBIDDEN`）与挖矿公式审批（403 `ADMIN_ACCOUNT_DISABLED`）都被拒；其会话立即失效（401）。
已停用账号不能再启用（不变）。

### 10.3 挖矿公式批准新增的拒绝原因

`POST /mining/formula-versions/{configVersion}/approve`（reviewer）：

| HTTP | code / reasonCode                               | 何时                                                      | 后台应显示                                 |
| ---- | ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| 403  | `PERMISSION_DENIED` / `ADMIN_OPERATOR_DISABLED` | 该 reviewer 绑定的运营人员已被停用（例如部署端 CLI 撤销） | 「你的审核权限已被停用，请联系平台管理员」 |
| 403  | `PERMISSION_DENIED` / `ADMIN_ACCOUNT_DISABLED`  | 批准过程中账号刚被停用                                    | 同上                                       |

两者都会写 `mining.formula.approve.failed`。

### 10.4 应急 CLI 批准在后台的表现

部署端应急命令 `pnpm mining:approve-formula <version> --confirm --approved-by <值班人> --reason "<原因>"`
（生产环境另需 `--i-know-this-bypasses-review`）批准的版本：

- 公式列表里该版本 `approvedBy: null`（没有后台账号）；
- 审计列表有 `mining.formula.approve` 行：`actor: "cli"`、`actorAccountId: null`、
  `after.approvedBy: "cli:<值班人>"`、`after.reason`、`after.bypass`（生产绕过审核为 `true`）、`after.channel: "cli"`。
  建议审计页对 `actor: "cli"` 的行加「应急通道」标记，`bypass: true` 标红。
- 被拒的尝试（如值班人就是草稿保存人）写 `mining.formula.approve.failed`（`actor: "cli"`，`after.reasonCode`）。

### 10.5 审计新增

| action                                       | targetType               | `after`                                                                                              |
| -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `account.unlock`（新）                       | `admin_account`          | `locked: false`、`reasonCode`、`idempotencyKey`；`before` 带 `failureCount`、`locked`、`lockedUntil` |
| `account.disable`（扩充）                    | `admin_account`          | 原字段 + `operatorEnabledBefore`                                                                     |
| `mining.formula.approve`（CLI，actor `cli`） | `mining_formula_version` | `channel: "cli"`、`approvedBy: "cli:<name>"`、`reason`、`bypass`、`draftAuthor`、`retiredVersion`    |
| `mining.formula.approve.failed`（CLI）       | `mining_formula_version` | `channel: "cli"`、`approvedBy`、`reason`、`bypass`、`reasonCode`                                     |

## 11. S132 变更（决策 0112）：Hooks 部署执行器进度

机器契约：`openapi/loop-admin.v1.json`（无新操作，只扩充 `GET /admin/v1/launch/projects` 的
`stage` 与 `GET /admin/v1/launch/projects/{projectId}` 的 `deploymentTasks[]`）。决策见
`docs/decisions/0112-hooks-deployment-executor.md`。Base URL、cookie、错误体同 §1 / §6。

### 11.0 给 loop-admin 的改动清单

1. `stage`（列表项与详情 `project.stage`，及列表 `?stage=` 过滤）新增 **`activated`**：最新配置版本
   的任务已在链上激活。`deploying` 的含义扩大为「执行器仍持有的任务」：`awaiting_executor`、
   `claimed`、`broadcast`、`confirmed`、`verified`、`reorged`，或可重试的 `failed`。
   `activeDeploymentJobId` 同口径（`activated` 时为 `null`）。不可重试的 `failed` 不算进行中，
   `stage` 回落到 `accepted` / `approved`。
2. 详情 `deploymentTasks[]` 的 `status` 取值扩为 9 个（同 App 文档 §9.1），每项新增只读字段：

| 字段                                                         | 类型                                | 说明                                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executorAddress`                                            | address \| null                     | 执行账户（Factory 的 `deploymentExecutor`）                                                                                                                      |
| `claimedBy`                                                  | string \| null                      | 执行器实例 ID（`hooks-executor:<host>:<pid>:<rand>`）                                                                                                            |
| `attemptCount`                                               | integer                             | 部署尝试次数（含重试）                                                                                                                                           |
| `txHash` / `txNonce`                                         | hash \| null / 十进制字符串 \| null | 部署交易（**广播前已入库**）与执行账户 nonce                                                                                                                     |
| `blockNumber` / `blockHash`                                  | 十进制字符串 \| null / hash \| null | 回执所在区块（重组后清空）                                                                                                                                       |
| `confirmations`                                              | integer \| null                     | 最近观测的确认数                                                                                                                                                 |
| `launchId`                                                   | bytes32 \| null                     | 核验后写入；链上事实，不是主键                                                                                                                                   |
| `deployedAddresses`                                          | object \| null                      | 核验后写入：`launchId`、`meme`、`hook`、`nft`、`curve`、`gate`、`escrow`、`snapshots`、`graduationAdapter`、`buybackAdapter`、`priceRecorder`、`buybackExecutor` |
| `verifiedChecks`                                             | string[]                            | 通过的核验项（28 项，见决策 0112 §4）                                                                                                                            |
| `activationTxHash` / `activationBlockNumber` / `activatedAt` | hash / 十进制字符串 / ISO \| null   | 激活交易与时间                                                                                                                                                   |
| `failure`                                                    | `{code, retryable}` \| null         | 失败码同 App 文档 §9.2                                                                                                                                           |
| `events[]`                                                   | array（≤100，升序）                 | 见 §11.1                                                                                                                                                         |
| `updatedAt`                                                  | ISO                                 | 最近一次状态/进度写入                                                                                                                                            |

3. 建议详情页「部署任务」卡片：状态徽标 + `txHash` / `activationTxHash` 链接（BscScan Testnet）+
   `confirmations` + 地址表（预测 vs 实际，二者 `meme` / `hook` 必须相同）+ 事件时间线。
   `failure.code = HOOKS_VERIFICATION_MISMATCH` 时把最后一条 `failed` 事件的 `details.failedChecks`
   原样列出（标红），这是「核验不一致、未激活」的审计证据。

### 11.1 `events[]`（详情专有字段）

```json
{
  "sequence": 6,
  "fromStatus": "confirmed",
  "toStatus": "failed",
  "kind": "failed",
  "txHash": "0x9a0c…41de",
  "blockNumber": null,
  "blockHash": null,
  "confirmations": null,
  "errorCode": "HOOKS_VERIFICATION_MISMATCH",
  "details": { "retryable": false, "failedChecks": ["hook_params"] },
  "actor": "hooks-executor:loop-dev:4127:5f2c1a9b",
  "createdAt": "2026-10-10T03:41:12.000Z"
}
```

- `details` 只含安全字段：`failedChecks`、`retryable`、`attempt`、`nonce`、`revert`（合约错误名）、
  `previousExecutor`、`checks`（通过项计数）。永不含私钥、签名、原始交易。
- `actor`：执行器实例；`created` / `cancelled`（项目方动作）为 `null`。
- 后台**没有**任何执行器写接口：重试由执行器按 `retryable` 自动完成；不可重试的失败需要项目方重新签名
  （新任务）或平台排查。

### 11.2 错误与不可用

无新错误码。执行器关闭（默认）时任务停在 `awaiting_executor`，`stage = deploying`，详情照常返回。

## 12. S138 变更（决策 0116）：挖矿小时结算参数、结算周期、资金对账

机器契约：`openapi/loop-admin.v1.json`（`/admin/v1/mining/parameter-versions*`、`/admin/v1/mining/epochs*`、
`/admin/v1/mining/funding`）。决策见 `docs/decisions/0116-mining-hourly-settlement.md`。Base URL、cookie、
错误体同 §1 / §6。旧的挖矿公式（`/mining/formula-versions`，§9.1）不变，管的是快照算力；本节是新的
小时结算参数，两者互不影响。

### 12.0 给 loop-admin 的改动清单

1. 新增「挖矿结算参数」页：列表 + 新建草稿（platform_admin）+ 审批（reviewer）+ 撤回（platform_admin）。
2. 新增「结算周期」页：最近 48 个小时的结算状态、预算、分母、已分配 / 未分配、输入摘要；详情页列出每个用户两轨
   本人 / 邀请 / 总算力与奖励；「回放」按钮（只读重算对比）。
3. 新增「奖励资金」卡片：合约余额 vs 已确权未领取负债，`alert = true` 时标红。
4. 仅测试环境：「手动结算某小时」按钮（`MINING_SETTLEMENT_TEST_TRIGGER=true` 时可用，否则 503）。

### 12.1 权限

| 路由                                                                             | 权限                                                      | 角色                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `GET /admin/v1/mining/parameter-versions`                                        | `console.read` 或 `formula.approve`                       | platform_admin、auditor、reviewer                   |
| `POST /admin/v1/mining/parameter-versions`                                       | `console.write`                                           | platform_admin                                      |
| `POST /admin/v1/mining/parameter-versions/{id}/approve`                          | `formula.approve`（且不是草稿作者、绑定的运营人员启用中） | reviewer                                            |
| `POST /admin/v1/mining/parameter-versions/{id}/withdraw`                         | `console.write`                                           | platform_admin                                      |
| `GET /admin/v1/mining/epochs`、`/epochs/{id}`、`/epochs/{id}/replay`、`/funding` | `console.read` 或 `audit.read`                            | platform_admin、auditor、reviewer、testnet_acceptor |
| `POST /admin/v1/mining/epochs/settle`                                            | `console.write` + 测试开关                                | platform_admin（仅测试环境）                        |

### 12.2 参数草稿

`POST /admin/v1/mining/parameter-versions`

```json
{
  "configVersion": "miningHourlyV1",
  "effectiveFrom": "2026-10-11T00:00:00.000Z",
  "parameters": {
    "releaseStartAt": "2026-10-11T00:00:00.000Z",
    "referralRatiosBps": [1000, 500, 300, 200, 100],
    "dailyBudgetNftRaw": "500000000000000000000000",
    "dailyBudgetAssetRaw": "500000000000000000000000",
    "releaseDays": 900,
    "minimumClaimRaw": "1000000000000000000",
    "assetWeights": [{ "assetId": "eip155:97:0x…6666", "weight": "1" }],
    "communityCoefficients": [{ "communityId": "…", "coefficient": "2" }]
  }
}
```

- `parameters` 中省略的字段取默认（列表接口 `defaults`）；`releaseStartAt` 必填（UTC 零点）。
- `communityCoefficients` 省略时冻结复制当前已审批的社区系数（`community_mining_weights`）；版本一旦批准不可修改，
  历史结算用当时的版本。
- `assetWeights` 只能填 launch2 / MEME v1 的币；未列出的资产权重为 0（不参与资产池）。
- `effectiveFrom` 必须在未来；批准时若已过去 → 409 `ADMIN_MINING_PARAMETERS_EFFECTIVE_PASSED`。小时内生效的版本
  会按生效时间切片（预算与邀请比例按该小时开始时的版本）。
- `201` → `{ version, audit }`。`version`：`versionId`、`configVersion`、`status`（`pending_approval` | `approved` |
  `withdrawn`）、`effectiveFrom`、`document`、`draftAuthor`、`approvedBy`、`approvedAt`、`createdAt`。

### 12.3 审批

`POST /admin/v1/mining/parameter-versions/{versionId}/approve`（空 body）。审计先写
`mining.parameters.approve.requested`（写不进 → 503 `ADMIN_AUDIT_UNAVAILABLE`，不批准），成功写
`mining.parameters.approve`，失败写 `mining.parameters.approve.failed`。

| HTTP | `code`                   | `reasonCode`                                                                                                                                                             |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 403  | `PERMISSION_DENIED`      | `ADMIN_ROLE_FORBIDDEN`、`ADMIN_FORMULA_SELF_APPROVAL`、`ADMIN_OPERATOR_DISABLED`、`ADMIN_ACCOUNT_DISABLED`                                                               |
| 404  | `NOT_FOUND`              | `ADMIN_MINING_PARAMETERS_NOT_FOUND`                                                                                                                                      |
| 409  | `ADMIN_CONFLICT`         | `ADMIN_MINING_PARAMETERS_STATE`、`ADMIN_MINING_PARAMETERS_EFFECTIVE_PASSED`、`ADMIN_MINING_PARAMETERS_EFFECTIVE_TAKEN`、`ADMIN_MINING_PARAMETERS_VERSION_EXISTS`（草稿） |
| 422  | `VALIDATION_FAILED`      | `ADMIN_MINING_PARAMETERS_INVALID`（`field`）、`MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`（`assetId`）                                                                      |
| 503  | `CAPABILITY_UNAVAILABLE` | `MINING_SETTLEMENT_UNAVAILABLE`、`ADMIN_DATABASE_UNAVAILABLE`、`ADMIN_AUDIT_UNAVAILABLE`                                                                                 |

### 12.4 结算周期

`GET /admin/v1/mining/epochs?before=<hourStart>` → `{ items: epoch[48], nextBefore }`。epoch 字段：
`epochId`、`hourStart`、`hourEnd`、`status`（`pending` | `settling` | `settled` | `failed`）、`trigger`
（`scheduled` | `test_trigger`）、`versionId`、`budgetNftRaw` / `budgetAssetRaw`、`denominatorNftPower` /
`denominatorAssetPower`、`allocated*Raw` / `unallocated*Raw`（某池分母为 0 时整池未分配，不转入另一池）、
`userCount`、`inputDigest`、`inputSummary`（`excludedAssets`、`unboundInstances`、`ambiguousAddressCount`、
`unattributedHoldingCount`、`versionIds`…）、`failureReasonCode`、`attemptCount`、`settledAt`、`updatedAt`。

- `failed` 的常见原因：`MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`、`MINING_SETTLEMENT_PRICE_MISSING`、
  `MINING_SETTLEMENT_INPUT_INVALID`；worker 每分钟重试。
- 索引落后（`MINING_SETTLEMENT_INDEXER_BEHIND`）、无参数（`MINING_PARAMETERS_PENDING`）的小时不会出现失败行，只是等待。

`GET /admin/v1/mining/epochs/{epochId}` → `{ epoch, rewards[≤500], rewardRowCount }`，rewards 每行：`userId`、两轨
本人 / 邀请 / 总算力、`levels`（五级：`ratioBps`、`effectiveMembers`、`nftPower`、`assetPower`、
`nftUnitsByCommunity`）、`nftRewardRaw`、`assetRewardRaw`、`totalRewardRaw`。

`GET /admin/v1/mining/epochs/{epochId}/replay` → `{ replay: { storedDigest, replayDigest, digestMatches,
rewardsMatch, mismatchedUserCount, reasonCode } }`。只读，不写库；`digestMatches = false` 通常表示链上事实被重组改写。

### 12.5 资金对账

`GET /admin/v1/mining/funding` →

```json
{
  "status": "available",
  "reasonCode": null,
  "contractAddress": "0x…",
  "liabilityRaw": "4000000000000000000",
  "balanceRaw": "1000000000000000000000000",
  "liabilityHintRaw": null,
  "paused": false,
  "blockNumber": "123456",
  "alert": false,
  "shortfallRaw": "0"
}
```

`liabilityRaw` = 全部用户「累计已结算 − 累计已领取」。`alert = balanceRaw < liabilityRaw`（`shortfallRaw` 为差额）。
未配置合约或链时 `status = unavailable`（`MINING_CLAIM_CONTRACT_NOT_CONFIGURED` / `MINING_CLAIM_CHAIN_NOT_CONFIGURED`），
负债照常返回，余额字段为 `null`。

### 12.6 手动结算（仅测试）

`POST /admin/v1/mining/epochs/settle`，body `{ "hourStart": "2026-10-10T10:00:00.000Z" }`（必须是整点）→
`{ outcome, reasonCode, epoch, audit }`，`outcome`：`settled` | `already_settled` | `skipped` | `failed`。规则与
worker 相同（小时必须已结束 + 宽限、索引已追上、参数在生效中）；已结算小时不会重算。
