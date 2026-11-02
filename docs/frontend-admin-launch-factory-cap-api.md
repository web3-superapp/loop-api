# loop-admin 对接：发射配置「当前新项目单地址上限」（S340-api / 决策 0195，主代理决策 0268）

只读展示。修改上限走治理多签（Safe）直接调用工厂 `setMaxCumulativeBuy(uint256)`（selector `0xcfc64a43`），**后台不发交易、没有写接口**。

## 1. 基址、请求头

- Base URL：`{ADMIN_API_BASE}/admin/v1`（staging：`https://admin-staging.quant-dinger.cc` 反代到 API），与现有发射审核页相同。
- 鉴权：后台会话 cookie（`POST /admin/v1/session`）；权限 `launch.read`（reviewer / acceptor 按 ops 授权范围看项目，但本字段对所有能进页的人都一样）。
- 响应头 `Cache-Control: no-store`。
- 没有新路由：字段加在现有两个读接口的响应**顶层**，是可选新键。loop-admin 的 `client.ts` 对响应只做 `JSON.parse` + 类型断言（宽松），旧版后台忽略它，不会报错。

## 2. 字段位置

- `GET /admin/v1/launch/projects`（列表）：`{ items, nextCursor, scope, factoryPurchaseCap }`
- `GET /admin/v1/launch/projects/{projectId}`（详情）：`{ project, factoryPurchaseCap, versions, … }`

```json
"factoryPurchaseCap": {
  "status": "available",
  "factoryAddress": "0x0c27…6bf1",
  "maxCumulativeBuy": "5000000000000000000000000",
  "adjustable": true
}
```

| 字段               | 类型                                 | 说明                                                                                                                                                                              |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`           | `"available"` \| `"unavailable"`     | 读链结果                                                                                                                                                                          |
| `factoryAddress`   | 地址 \| `null`                       | 当前配置的目标工厂（未配置为 null）                                                                                                                                               |
| `maxCumulativeBuy` | 十进制整数字符串（18 位小数）\| null | 工厂 `maxCumulativeBuy()` 现值 = **此刻新部署的项目会拿到的**单地址累计买入上限；`5000000000000000000000000` = 500 万 MEME。前端按 18 位小数换算显示，禁止转 JS number            |
| `adjustable`       | `true` \| `false` \| `null`          | `true` = S340 工厂（多签可调）；`false` = S209 工厂（部署时固定）或更老工厂（无此 getter，此时 `maxCumulativeBuy` 为 null，固定 500 万）；`null` = 未知（OfficialTax 线或读不到） |

建议文案：「当前新项目单地址上限：5,000,000 MEME（多签可调，仅影响之后创建的项目）」；`adjustable=false` 时去掉括号说明改为「（工厂固定）」。

## 3. 每个项目自己的上限（详情页）

项目级上限 = 该项目 CurveEngine 部署时拿到的值，**永远不随工厂后续修改变化**。数据已在详情 `deploymentTasks[].events[].details` 里（无新增键）：

| 事件 `kind` | details 键                      | 含义                                                                               |
| ----------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `broadcast` | `factoryMaxCumulativeBuy`       | 执行器签名部署交易前读到的工厂值（S340 工厂才有）                                  |
| `broadcast` | `signedMaxCumulativeBuy`        | 项目方保存配置时看到的值（`fixedEconomics.perAddressLifetimeBuyCapRaw`）           |
| `verified`  | `curveMaxCumulativeBuy`         | 部署后核验的 curve 实际上限（= 链上 `LaunchMaxCumulativeBuy` 事件值），以此为准    |
| 两者都可能  | `maxCumulativeBuyChanged: true` | 保存配置后多签改过上限、项目按新值部署；**不阻断**，仅提示（API 同时记 warn 日志） |

## 4. 错误与 unavailable

- 本字段永不让页面失败：没有配置工厂读取器（发射关闭 / 缺 RPC / 缺工厂地址）、RPC 失败、3 秒超时、读数越界 → `status: "unavailable"`，`maxCumulativeBuy` / `adjustable` 为 null（`factoryAddress` 有配置时照给）。前端显示「暂不可读」，**不要**回落显示 500 万默认值。
- 两个接口原有错误不变：401 `UNAUTHENTICATED`、403 `PERMISSION_DENIED`（`OPS_FORBIDDEN`）、404 `NOT_FOUND`（详情 `ADMIN_LAUNCH_PROJECT_NOT_FOUND`）、503 `CAPABILITY_UNAVAILABLE`（无数据库）。
- 「最近一次修改」（`MaxCumulativeBuyUpdated` 事件的区块 / 时间）本批**未提供**：现有 launch2 索引 lane 只按项目实例扫工厂日志，没有工厂级事件表；免费 RPC 回扫老区块不可靠。需要时另开批次（新表 + 迁移 + 索引）。
