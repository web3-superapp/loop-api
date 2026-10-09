# 前端交接 · `GET /v2/meta/about` 的 `configVersions[]` 键说明（S27c / 决策 0049）

`about` 页「当前规则」一栏渲染 `configVersions[]`。每行是 `{ module, configVersion, effectiveAt }`；
`module` 是模块标识（同一个值也出现在各模块响应的 `policy.configVersion` / `configVersion` 里，
所以键名**不改**），但它是内部标识，**不得直接上屏**——按下表映射中文名，`configVersion` 用等宽字体
原样显示，`effectiveAt` 为 `null` 时不显示生效时间。

- Base URL 与 headers：公共接口，不需要 Bearer 与任何 `X-Loop-*` header；`GET /v2/meta/about`，
  响应 `cache-control: no-store`。完整响应样例见 `docs/frontend-v2-security-settings-api.md` §5。
- 行数不固定：按服务端下发多少行渲染多少行；遇到下表没有的 `module`，显示「其他规则」+ 键名以外的
  字段，不要崩。

| `module`          | 中文名           | 一句话说明（可作副标题）                                         | 出现条件                                                                                                                |
| ----------------- | ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `productPolicy`   | 产品策略         | 五个 Tab、默认落地页与整体产品规则的版本                         | 恒有，永远是第一行                                                                                                      |
| `clientPolicy`    | 客户端策略       | 运营对当前客户端的版本门槛 / 地区 / 条款要求的覆盖版本           | **只在**运营通过 `V2_CLIENT_POLICY_CONFIG_VERSION` 覆盖、与产品策略版本不同的部署里出现；相同则缺席（同一版本不列两次） |
| `sessionPolicy`   | 登录会话规则     | 设备会话如何创建、限额与撤销的规则版本                           | 恒有                                                                                                                    |
| `community`       | 社区规则         | 社区创建、成员、角色与治理的规则版本                             | 恒有                                                                                                                    |
| `marketTrending`  | 行情热榜规则     | 行情页热门排序的口径版本                                         | 恒有                                                                                                                    |
| `deviceRisk`      | 设备风险提示规则 | 「24 小时内新设备 ≥ N」提示的阈值版本                            | 恒有                                                                                                                    |
| `accountSettings` | 账号设置规则     | 账号级设置项的结构版本（与 `settings` 页 `configVersion` 相同）  | 恒有                                                                                                                    |
| `support`         | 客服工单规则     | 工单分类、字数与答复时限的版本                                   | 恒有                                                                                                                    |
| `swapPolicy`      | 兑换规则         | 兑换报价、滑点与手续费口径的版本                                 | 恒有                                                                                                                    |
| `bscWriteCanary`  | 链上写入灰度规则 | 链上写入（发送 / 授权 / 兑换）灰度放量的资产白名单与单笔上限版本 | **只在** `BSC_WRITES_ENABLED=true` 的部署里出现；写开关关闭时缺席（不是 unavailable 占位，也不要给「未开放」行）        |

## 为什么 `clientPolicy` 之前与 `productPolicy` 值相同

`GET /v2/meta/client-policy` 是从产品策略投影出来的客户端策略；没有运营覆盖时它的
`configVersion` 就是产品策略的版本（`productPolicyV2.2026-09-01`）。以前 about 页把这个投影
无条件列了一行，于是两行同值。现在只有版本不同时才单列。

## 与 `GET /v2/meta/client-policy` 的关系

`client-policy` 的顶层键（`contractVersion` / `configVersion` / `effectiveAt` / `defaultRoute` /
`navigation` / `versionGate` / `regionGate` / `termsGate`）不是「当前规则」列表的一部分，about 页不渲染它们；
`termsGate` 在 about 响应里单独有一份，语义见 `docs/frontend-v2-security-settings-api.md` §5。

## 错误码

| HTTP | `code`            | 处理                             |
| ---- | ----------------- | -------------------------------- |
| 400  | `INVALID_REQUEST` | 带了 query 或 body；前端不应触发 |
| 500  | `INTERNAL_ERROR`  | 整页错误态，可重试               |
| 503  | `REQUEST_TIMEOUT` | 整页错误态，可重试               |

只读接口失败时用「读不到 / 请稍后再试」口吻，**不要**用写入口吻（走查 `about` 首次进入报「操作没有完成」是前端错误分类，与 A-1 同族）。
