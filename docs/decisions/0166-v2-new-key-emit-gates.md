# 0166 · 新增响应键默认不下发：launch2 成交 `account` 与邀请中心字段的开关（S248-api，2026-10-19）

## 1. Status

已实现（分支 `fix/S248-launch2-account-emit-gate`，基线 `a910c08`）。紧急热修。无迁移、无新表、无新错误码、无新路径。新增 env `LAUNCH2_TRADER_ACCOUNT_EMIT`、`REFERRAL_CENTER_EMIT`（均 `off|on`，默认 `off`，其他值拒绝启动）。OpenAPI 变化：`GET /v2/referral` 的 `inviteLink` / `stats` 从必带改为可选；相关描述文字。

## 2. Context

- `a910c08` 上 staging 后，所有已发布 App（含 build 30 / loop-mobile `0a37ce8e`）的 launch2 详情页整页报「返回的数据不完整」，staging 已回滚到 `40921be`。
- **根因**：决策 0162（S239）给 `/v2/launch2/instances/{id}` 的 `instance.recentTrades[]`、`GET /v2/launch2/overview` 的 `activity[]`、`…/pool/trades` 的 `trades[]` 新增了 `account` 键。App 的 V2 解码器是严格的（`LoopV2Contract.strictMap`：键集合必须与预期**完全相等**，多一个键即 `invalidPayload`）。0162 审查只核对了「schema 里是可选属性」，漏了「已发布客户端会拒绝未知键」——服务端 schema 可选 ≠ 客户端兼容。
- 同一批核对（`40921be` 与 `a910c08` 的 `openapi/loop-api.v2.json` 逐条比对既有路径的 2xx 响应属性）发现，除 launch2 三处外**只有** `GET /v2/referral` 有同类问题：0162 §B.2 新增 `inviteLink`、`stats`，`boost` 多了 `available` 形态。build 30 的 referral 解码器用六键 `strictMap`，`boost` 只认 `{status:"unavailable", reasonCode}`，因此「挖矿 → 推广」页同样会整页失败。本热修一并处理。
- MEME 成交（`GET /v2/meme/tokens/{id}/trades`）的 `account` 是决策 0101 起的**原有**字段，0162 §D 只多了 null 的情形，形状不变，**不动**。
- S243（UTF-8 ticker）、S245（listing，已按客户端兼容处理）、S246（USD1 来源 / 买入税）没有新增响应键，不受影响。

## 3. Decision

### A. `LAUNCH2_TRADER_ACCOUNT_EMIT`（默认 `off`）

- `off`：三处投影（`instance.recentTrades[]`、`overview.activity[]`、`pool/trades.trades[]`）**不带 `account` 键**（键不存在，不是 null），并**跳过**钱包 → 账户目录查询（`WalletAccountDirectory.resolve` 不调用，不白查库）。
- `on`：行为与决策 0162 §A 相同。
- 实现：`config.launch2.traderAccountEmit` → `createLaunch2Service({ traderAccountEmit })`；`tradeOf` / `activityOf` 接收 `null` 映射、`poolTradeOf` 接收 `undefined` 时省略键。`projectLaunch2Overview` 不传 `accounts` 时同样省略键。
- Schema：`account` 本就不在 `required` 中；描述加注「OPTIONAL — 须全部受支持客户端 ≥ build 31 才可开启」。

### B. `REFERRAL_CENTER_EMIT`（默认 `off`）

- `off`：`GET /v2/referral` 保持 0162 之前的六键形状（`inviteCode, binding, levels, boost, rules, contractVersion`），`boost` 恒为 `unavailable` / `MINING_REFERRAL_BOOST_PENDING`；不读 `getInviteeStats`、`getReferralBoost`。`levels[].counts` 仍按 0162 §E 同源规则计（只是数值口径，形状不变）。
- `on`：行为与决策 0162 §B.2 相同。
- Schema：`inviteLink`、`stats` 移出 `required`，描述加注同上。
- `GET /v2/referral/invitees`（新路径）与 `GET /i/{code}`（非 `/v2`）不受影响，照常提供。

### C. 开启条件

移动端 codec 把对应键加为**可选键**（launch2 三处 `account`；referral 的 `inviteLink`、`stats`，`boost` 两种形态）并随 build ≥ 31 发版，且所有仍受支持的已发布版本都 ≥ 31 后，才在目标环境把开关切到 `on`。在此之前 build ≥ 31 也必须能在键缺省时正常工作（显示钱包地址 / 用邀请码分享）。

### D. 以后给 `/v2` 加字段的规矩

**已发布 App 的 V2 解码器严格拒绝未知键。任何已有响应对象上的新增键，必须先在移动端 codec 以可选键落地并随版本发布，服务端才可下发；在此之前服务端须用默认 `off` 的 env 开关把新键关掉（参考决策 0163 / S245 的 listing 处理与 `LAUNCH_GRADUATED_LIST`）。** 「schema 里是可选属性」不构成兼容依据。审查新增响应字段时，必须对照已发布 App 的 codec 核对。新路径不受此限。

## 4. Consequences

- 本热修上线后，build ≤ 30 的 launch2 详情页、发射台首页、外盘成交列表和推广页恢复正常；头像点开资料页与邀请链接 / 统计 / 可用加成暂不可见，直到开关打开。
- 两个开关各自独立，可分别开启。
- 测试：`test/v2-launch2-trader-accounts.test.ts`（0162 用例以 `on` 运行；新增 `off` / 未设置两例：三条路由均无 `account` 键且目录零查询）、`test/v2-launch2-overview.test.ts`（默认无 `account` 键）、`test/v2-referral-routes.test.ts`（0162 用例以 `on` 运行；新增 `off` / 未设置两例：六键形状、`boost` 不可用、不读 stats / boost）、`test/config.test.ts`（两个 env 的默认值与非法值）。
