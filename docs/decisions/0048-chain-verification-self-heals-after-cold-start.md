# 0048 · 链 ID 校验冷启动后自愈（bscRead 不再自我维持关闭）

- 日期：2026-09-16
- 来源：真机验收预检 `docs/acceptance/2026-09-16-device-preflight.md` §4 B2 / §6 第 3 条；03 §4.5d
- 范围：`src/integrations/bsc/chain-verification-watch.ts`、`src/app.ts`；接口面不变

## 问题

`bscRead`（以及依赖它的 `sendApprovals`/`swap`）只有在 `eth_chainId` 被实际观测到等于 56 时才 `available`。读客户端把校验状态分成四种：`verified`/`mismatched` 是终态并缓存；`unreachable`/`unknown` 只在**下一次链上读**时才重探。

冷启动时（实测 `buildApp()` 后 `t+0ms`）状态是 `unknown`（探测在途）或首次探测失败后的 `unreachable`。客户端在冷启动读一次 `/v2/meta/capabilities` 拿到 `bscRead: unavailable`，此后按能力门不再发任何链上读——于是没有人触发重探，关闭状态自我维持到下一次 API 重启（03 §4.5d 记录的处置是"重启"）。

## 裁决

两条都做，都在服务端，客户端不需要任何动作：

1. **启动重试**：`verifyAtStartup()` 在结果为 `unreachable`/`unknown` 时按指数退避重探：首次延迟 2 s，翻倍至上限 16 s，最多 5 次或总预算 60 s（`defaultChainVerificationRetryPolicy`），直到 `verified`/`mismatched`。
2. **投影触发重探**：能力投影读到的 `bscChainVerification()` 现在经过 `current()`：返回值仍是客户端**当前实际知道**的状态（绝不提前宣称 `verified`），但若该状态非终态，则在后台调度一次 `verifyChain()`，30 s 内最多一次（`defaultChainReprobeThrottleMs`），不阻塞响应。

不变量：

- `mismatched` 是配置错误不是抖动，**永不重试**（启动与投影两条路径都不重试）。
- 没有配置 RPC 端点（`endpointRefs` 为空）时不重探；此时投影早已因 `BSC_RPC_NOT_CONFIGURED` 关闭。
- 重探全部复用读客户端自己的 `verifyChain()`，它对在途探测去重，因此启动重试与投影重探并发时不会多打 RPC。
- 定时器 `unref()`，`app.close()` 时 `stop()` 取消挂起的延迟，测试进程不会被拖住。
- launch 链槽（Decision 0038）走同一启动重试；它没有单独的能力投影，所以不接投影重探。

## 状态机

```
unknown ──probe──▶ verified   (终态，缓存)
   │                ▲
   ├──probe──▶ mismatched (终态，缓存，不重试)
   │
   └──probe──▶ unreachable ──(启动退避 / 投影节流重探)──▶ 回到 probe
```

## 实测时间线（真实 Development 配置 + 真实库；RPC 先指向本机空端口，t+5 s 起用本机代理转发到真实端点）

见提交信息。关键点：首次探测 `unreachable` → 退避重探 → 端点恢复后的下一次重探即翻 `verified`，全程无客户端动作。

## 错误码 / unavailable 行为

不新增错误码。`bscRead` 的 `reasonCode` 仍是 `BSC_CHAIN_VERIFICATION_PENDING`（`unknown`）/ `BSC_RPC_UNREACHABLE`（`unreachable`）/ `BSC_CHAIN_ID_MISMATCH`（`mismatched`）；变化只是 `unreachable` 会在几十秒内自愈。

## 文档待更新（主代理）

03 §4.5d 的处置从"重启 API"改为"等待几十秒自愈（启动退避上限 60 s；投影重探每 30 s 一次）"。本仓库不改 03。

## 顺带发现（需要主代理/运维决策）

`ops/api-dev.env` 的 `BSC_RPC_URLS` 第一个端点（`1rpc.io`）当前对每个调用都返回 `-32001 "You've reached the usage limit for your current plan"`；开发栈目前全靠 viem `fallback` 转到后面的端点。这解释了预检看到的"冷启动前 ~15 s 不可用"（首个端点先失败再回退）。建议把它移到列表末尾或换掉；本任务不改 ops。
