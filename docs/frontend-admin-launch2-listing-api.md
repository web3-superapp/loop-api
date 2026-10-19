# loop-admin 对接：MEME v2 实例列表隐藏（S245 / 决策 0163）

## 1. 基址、请求头

- Base URL：与其他后台接口相同，`{ADMIN_API_BASE}/admin/v1`（staging：`https://admin-staging.quant-dinger.cc` 反代到 API）。
- 鉴权：后台会话 cookie（`POST /admin/v1/session` 登录所得），与 `/admin/v1/meme/tokens/*` 完全一致；写接口与 MEME listing 相同（仅会话 cookie，无 Idempotency-Key）。
- 权限：读 `console.read`；写 `console.write`（即 MEME v1 隐藏同一权限位，仅 platform_admin）。
- 响应头 `Cache-Control: no-store`。

## 2. `GET /admin/v1/launch2/instances?listing=&q=`

| query     | 说明                                                               |
| --------- | ------------------------------------------------------------------ |
| `listing` | 可选，`visible` \| `hidden`                                        |
| `q`       | 可选，≤ 64 字；名称 / ticker 子串，或精确 instanceId，或 MEME 地址 |

全部实例（所有链），按注册时间新→旧，最多 200 条，无分页。

```json
{
  "items": [
    {
      "instanceId": "2f0d6a3e-6c1b-4f7e-9a51-0b8c2d4e6f10",
      "projectId": "7b1e…",
      "chainId": "eip155:97",
      "name": "S137 Testnet S13001",
      "ticker": "S13001",
      "memeAddress": "0x…6666",
      "stage": "public",
      "graduatedAt": null,
      "registeredAt": "2026-09-30T08:00:00.000Z",
      "listing": "visible",
      "listingReason": null,
      "listingUpdatedAt": null,
      "listingUpdatedBy": null
    }
  ]
}
```

`stage` 是库里存的阶段（可能比 App 显示的时钟推导阶段慢一点），仅供参考。

## 3. `PUT /admin/v1/launch2/instances/{instanceId}/listing`

请求：

```json
{ "listing": "hidden", "reason": "测试网验收项目，不对用户展示" }
```

- `listing`：`visible` \| `hidden`，必填。
- `reason`：`hidden` 必填（去首尾空白后 1–280 字，无控制字符）；`visible` 可不传（保留上一条原因）。原因只在后台和审计里，App 看不到。

响应 200：

```json
{
  "instance": {
    "instanceId": "2f0d6a3e-…",
    "listing": "hidden",
    "listingReason": "测试网验收项目，不对用户展示",
    "listingUpdatedAt": "2026-10-19T10:00:00.000Z",
    "listingUpdatedBy": "admin",
    "…": "同 §2 行"
  },
  "changed": true,
  "audit": { "auditId": "…", "seq": "…", "at": "…" }
}
```

- 写入当前已有的值也 200，`changed: false`，同样记一条审计。
- 审计：`GET /admin/v1/audit?action=launch2.listing.update` 可查，target `launch2_instance`，before / after `{listing, reason}`。
- 生效：下一次读即生效（App 列表 / 发射台计数与动态 / 官网列表 / 广场事件帖）。详情直达仍可读。

## 4. 错误（七字段错误体，`detailsSafe.reasonCode` 区分）

| HTTP | code                     | reasonCode                         | 何时 / 前端提示                         |
| ---- | ------------------------ | ---------------------------------- | --------------------------------------- |
| 400  | `INVALID_REQUEST`        | —                                  | `listing` 非法、多余字段、`q` 过长      |
| 401  | 会话错误（同既有）       | —                                  | 未登录 / 会话过期 → 跳登录              |
| 403  | `PERMISSION_DENIED`      | `ADMIN_ROLE_FORBIDDEN` 等          | 非 platform_admin 写 → 隐藏按钮         |
| 404  | `NOT_FOUND`              | `ADMIN_LAUNCH2_INSTANCE_NOT_FOUND` | 实例不存在                              |
| 422  | `VALIDATION_FAILED`      | `ADMIN_REASON_TEXT_REQUIRED`       | 隐藏没填原因                            |
| 422  | `VALIDATION_FAILED`      | `ADMIN_REASON_TEXT_INVALID`        | 原因超 280 字或含控制字符               |
| 503  | `CAPABILITY_UNAVAILABLE` | `ADMIN_DATABASE_UNAVAILABLE`       | 后端无数据库，什么都没写 → 提示稍后重试 |

## 5. unavailable 行为

后端无数据库时两条接口都 503，不返回假数据；页面显示「暂不可用」，不要缓存旧列表冒充当前状态。

## 6. 页面建议（不在 S245 本批）

1. 「MEME」菜单下新增「MEME v2 实例」页：表格 + `listing` 筛选 + 搜索框。
2. 行操作「隐藏」（弹窗，原因必填，≤ 280 字）/「恢复」（原因可选）。
3. 可选：发射项目详情的 MEME v2 区块加同一开关。
