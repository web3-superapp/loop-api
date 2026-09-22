# 前端联调：V2 Community AI（S68 / 决策 0066）

本文是 `community-ai` 页面的前端交接契约。权威机器契约为
`openapi/loop-api.v2.json`。通用规则（Base URL、`X-Request-ID`、错误体七字段）
沿用 `docs/frontend-v2-session-api.md` 与 `docs/api-v2-conventions.md`。

覆盖页面：`community-ai`（社区 AI 状态页 + 提问）。

## 1. Base URL、启用条件与 headers

- Development：`https://api-dev.quant-dinger.cc`；本机 `http://127.0.0.1:3000`
  （或 `PORT` 指定端口）。
- 后端 `V2_MODULES_ENABLED` 必须包含 `community`。未包含时三条路径全部返回
  `404 NOT_FOUND`（V2 错误体），且不会校验 Bearer。
- 前端必须先读 `GET /v2/meta/capabilities`：

| capabilityId  | 取值                                         | UI 含义                                                             |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `communityAi` | `available`                                  | 入口可点，三条接口可调用                                            |
| `communityAi` | `deferred` + `COMMUNITY_AI_RUNTIME_DEFERRED` | 后端没有配置 `ANTHROPIC_API_KEY`：入口置灰并显示「AI 助理尚未接入」 |

只有这两种状态，没有第三种。`deferred` 时不要调用本模块接口，也**不要**回退到
任何本地文案、示例回答或缓存答案。

- 读接口 header：

```text
Authorization: Bearer <current Privy access token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
```

- 写接口（`ask`、`report`）再加**恰好一个**规范小写 UUIDv4：

```text
Idempotency-Key: <canonical lowercase UUIDv4 for this logical operation>
```

- 读接口带 `Idempotency-Key` 返回 `400 INVALID_REQUEST`；写接口缺失、重复或非
  规范 UUIDv4 同样 `400`。未知 query、未知 body 字段一律 `400 INVALID_REQUEST`。
- 所有响应 `Cache-Control: no-store`；`X-Request-ID` 是服务端生成的 UUID，错误体
  `correlationId` 与之相等。

## 2. `GET /v2/communities/{communityId}/ai/overview`

社区 AI 首屏。一次返回能力清单、知识快照、示例问题和今日简报。

### 响应

```json
{
  "capabilities": [
    {
      "capabilityId": "projectKnowledge",
      "title": "项目知识",
      "summary": "白皮书、Tokenomics、Roadmap、FAQ",
      "availability": "unavailable",
      "reasonCode": "KNOWLEDGE_DOCUMENTS_NOT_INGESTED",
      "adminOnly": false
    },
    {
      "capabilityId": "communitySupport",
      "title": "社区客服",
      "summary": "CA 是什么、怎么买、怎么参与挖矿",
      "availability": "available",
      "reasonCode": null,
      "adminOnly": false
    }
  ],
  "knowledge": {
    "sourceCount": 4,
    "updatedAt": "2026-09-22T03:00:00.000Z",
    "sources": [
      {
        "sourceId": "s1",
        "kind": "communityProfile",
        "label": "社区档案：PEPE",
        "observedAt": "2026-09-22T03:00:00.000Z"
      }
    ],
    "omittedSources": [
      {
        "kind": "announcements",
        "reasonCode": "ANNOUNCEMENT_SOURCE_UNAVAILABLE"
      }
    ],
    "documents": {
      "status": "unavailable",
      "reasonCode": "KNOWLEDGE_DOCUMENTS_NOT_INGESTED"
    }
  },
  "exampleQuestions": [
    "这个社区的代币现在多少钱",
    "怎么参与挖矿",
    "这周社区在讨论什么"
  ],
  "brief": {
    "status": "available",
    "messageCount": 42,
    "bounded": false,
    "windowHours": 24,
    "summary": "今天社区主要在讨论挖矿权重与新绑定资产的流动性。",
    "model": "claude-sonnet-5",
    "generatedAt": "2026-09-22T03:00:00.000Z"
  },
  "disclaimer": "本回答由 AI 根据下列来源生成……",
  "contractVersion": "2.0"
}
```

### 渲染规则（强制）

1. **能力清单**共 8 项，服务端已按权限过滤：`communityAnalytics`（社区分析）
   只在 owner/admin 的响应里出现。客户端**不得**自行补齐缺失的项，也不得按
   `adminOnly` 自己决定显示与否。
2. `availability: "unavailable"` 的能力必须置灰并展示 `reasonCode` 对应文案，
   不要隐藏（原型上这 8 项都可见）。当前只有 `communitySupport`、
   `assetInformation`、`communityGuidance` 是 `available`。
3. **不要显示「知识库 N 篇文档」**。后端没有文档库，`knowledge.documents` 永远
   是 `unavailable`。顶部请渲染「知识源 {sourceCount} 项 · 更新于
   {updatedAt}」；`updatedAt` 为 `null` 时显示「暂无可用来源」。
4. `brief.status === "available"` 时渲染「今日 {messageCount} 条讨论」+
   `summary`；`bounded === true` 时文案必须是「至少 {messageCount} 条」。
   `brief.status === "unavailable"` 时按 `reasonCode` 显示空态，不要显示 0 条。
5. `brief` 是模型生成的，必须带 AI 生成标识与 `disclaimer`。

### `brief.reasonCode` 一览

| reasonCode                          | 含义                                 |
| ----------------------------------- | ------------------------------------ |
| `COMMUNITY_AI_MEMBERSHIP_REQUIRED`  | 未加入该社区（先引导加入）           |
| `COMMUNITY_CHAT_NOT_CONNECTED`      | 官方群还没开通 / Stream 未接         |
| `COMMUNITY_CHAT_NOT_OBSERVED`       | 本次读取官方群失败                   |
| `COMMUNITY_AI_PROVIDER_UNAVAILABLE` | 模型调用失败（可重试）               |
| `COMMUNITY_AI_PROVIDER_REJECTED`    | 模型确定性拒绝（不要重试，联系后端） |
| `COMMUNITY_AI_PROVIDER_MALFORMED`   | 模型返回不符合契约                   |

## 3. `POST /v2/communities/{communityId}/ai/ask`

### 请求

```http
POST /v2/communities/3fa85f64-5717-4562-b3fc-2c963f66afa6/ai/ask
Authorization: Bearer <token>
X-Loop-Contract-Version: 2.0
X-Loop-Client-Version: 1.0.0
Idempotency-Key: 4f605172-8d9e-4fa0-8123-3d4e5f607182
Content-Type: application/json

{ "question": "怎么参与挖矿" }
```

`question` 去空白后 2–500 个码点，不允许控制字符。**后端不记录问题原文**。

### 响应 `200`

```json
{
  "answerId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
  "answer": "这个社区绑定的资产当前价格是 0.0000123 USD [s2]，社区总算力 1234 [s3]。",
  "refusal": null,
  "citations": [
    {
      "sourceId": "s2",
      "kind": "assetFacts",
      "label": "绑定资产行情：PEPE",
      "observedAt": "2026-09-22T02:58:00.000Z"
    }
  ],
  "sources": [
    {
      "sourceId": "s1",
      "kind": "communityProfile",
      "label": "社区档案：PEPE",
      "observedAt": "2026-09-22T03:00:00.000Z"
    }
  ],
  "omittedSources": [
    { "kind": "announcements", "reasonCode": "ANNOUNCEMENT_SOURCE_UNAVAILABLE" }
  ],
  "model": "claude-sonnet-5",
  "generatedAt": "2026-09-22T03:00:01.000Z",
  "disclaimer": "本回答由 AI 根据下列来源生成……",
  "contractVersion": "2.0"
}
```

### 渲染规则（强制）

1. 气泡必须带 **AI 生成标识**（模型名 `model` + `generatedAt`），并在会话底部
   常驻 `disclaimer`。禁止把回答呈现为「官方答复」。
2. 回答正文里会出现 `[s2]` 形式的来源编号，必须能点击跳到 `citations` 列表；
   来源条目显示 `label` 与 `observedAt`（「观察于 …」）。
3. `citations` 只会包含本次 `sources` 里的条目，客户端**不要**再做映射猜测；
   `citations` 为空时仍要显示 `sources` 折叠区，说明回答基于哪些来源。
4. `refusal !== null` 时 `answer` 可能为空：直接把 `refusal` 作为助理回复展示
   （通常是「这属于投资建议，我只提供事实」），**不要**重试或换问法自动重问。
5. `omittedSources` 建议折叠展示为「本次未使用的来源」，帮助用户理解为什么
   AI 不知道某些事情。
6. 每条回答旁必须有**举报入口**，带上 `answerId`。

### 错误

| HTTP | code                         | detailsSafe                                          | 客户端处理                               |
| ---- | ---------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| 400  | `INVALID_REQUEST`            | —                                                    | 问题长度/字符非法，或 header 不合规      |
| 401  | `AUTH_REQUIRED`              | —                                                    | 重新登录                                 |
| 401  | `AUTH_INVALID`               | —                                                    | 重新登录                                 |
| 403  | `PERMISSION_DENIED`          | `{"reasonCode":"COMMUNITY_AI_MEMBERSHIP_REQUIRED"}`  | 引导先加入社区                           |
| 404  | `NOT_FOUND`                  | —                                                    | 社区不存在或不可见                       |
| 409  | `IDEMPOTENCY_CONFLICT`       | —                                                    | 同一个 key 用于了不同问题：换新 key 重发 |
| 409  | `ACCOUNT_BOOTSTRAP_REQUIRED` | —                                                    | 先完成账号引导                           |
| 429  | `RATE_LIMITED`               | `{"scope":"user"}`                                   | 每账号每分钟 6 次，提示稍后再问          |
| 429  | `RATE_LIMITED`               | `{"scope":"community"}`                              | 该社区当天额度用尽，提示明天再来         |
| 503  | `CAPABILITY_UNAVAILABLE`     | `{"reasonCode":"COMMUNITY_AI_RUNTIME_DEFERRED"}`     | 未接入，整页置灰                         |
| 503  | `CAPABILITY_UNAVAILABLE`     | `{"reasonCode":"COMMUNITY_AI_PROVIDER_UNAVAILABLE"}` | 可重试（指数退避）                       |
| 503  | `CAPABILITY_UNAVAILABLE`     | `{"reasonCode":"COMMUNITY_AI_PROVIDER_REJECTED"}`    | 不要重试，上报                           |
| 503  | `CAPABILITY_UNAVAILABLE`     | `{"reasonCode":"COMMUNITY_AI_PROVIDER_MALFORMED"}`   | 不要重试，上报                           |
| 503  | `CAPABILITY_UNAVAILABLE`     | `{"reasonCode":"COMMUNITY_AI_NO_KNOWLEDGE_SOURCE"}`  | 本社区暂无任何可用来源                   |

**重试语义**：`ask` 是幂等写。网络失败后**用同一个 `Idempotency-Key` 重发同一个
问题**会拿回同一条回答且不再消耗模型额度；换了问题必须换 key。

## 4. `POST /v2/communities/{communityId}/ai/answers/{answerId}/report`

### 请求

```json
{ "reason": "inaccurate", "note": "价格和行情页不一致" }
```

`reason` ∈ `inaccurate | harmful | offTopic | privacy | other`；`note` 可选，去
空白后 1–500 个码点。

### 响应 `201`

```json
{
  "answerId": "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
  "reportId": "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
  "reason": "inaccurate",
  "createdAt": "2026-09-22T03:05:00.000Z",
  "contractVersion": "2.0"
}
```

同一条回答同一个账号只会有一条举报；重复提交返回同一条 `reportId`（仍是
`201`）。只能举报**自己收到的**回答，别人的 `answerId` 返回 `404 NOT_FOUND`。

错误集合同 `ask`（少了 429 的 `scope: community`，多了 `404`）。

## 5. 后端保证与不保证

保证：

- 回答只基于本次 `sources`；官方群消息只在调用者是该社区**在籍成员**时才会进入
  上下文，且只取最近 7 天最多 100 条。
- 消息原文不落库；问题原文与消息原文不写日志。
- 每条回答都可举报、可审计。

不保证（客户端不要暗示）：

- 没有白皮书/Tokenomics/Roadmap 文档库（`projectKnowledge` 关闭）。
- 没有公告、X、Blog 聚合（`projectUpdates` 关闭）。
- 没有 AI 巡查和社区分析（`aiPatrol`、`communityAnalytics` 关闭）。
- AI 永远不给投资建议、评级或涨跌预测；要求它这么做会得到 `refusal`。
