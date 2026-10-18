# 0160 · Hooks 签名请求路径的链上读取时间上限（S229-api，2026-10-18）

## 1. Status

已实现（分支 `fix/S229-signing-request-budget`，基线 `aefffe0`）。无迁移、无 SQL 变化、无新错误码。OpenAPI 只改 `GET /v2/launch/projects/{projectId}/hooks-config/signing-request`（`getV2HooksLaunchSigningRequest`）的描述文字。

## 2. Context

决策 0155（提交 `f593ab0`）给提交路径 `POST …/hooks-deployments` 加了并发读与 8 s 总上限。S224 备注：App 取待签名数据的 `GET …/hooks-config/signing-request` 仍是串行读链、没有上限：模板校验（`nftSaleDuration`，LoopDynamic 另读 `loopDynamicTemplate`）→ `ownerVersionLaunchId` → `nonce` → `tokenDeployment` → 挖 MEME salt → `hookDeployment` → 再读模板 → 挖 Hook salt。每次 reader 调用都会先做网络 / Factory code 校验，fallback 每个 URL 等 8 s，慢 RPC 下总耗时可超过 15 s 的 `handlerTimeout`：客户端收到超时，服务端仍在跑。

## 3. Decision

- **并发**：互相独立的读——模板校验、`ownerVersionLaunchId`、`nonce`、`tokenDeployment`、（LoopDynamic）模板参数——用 `Promise.allSettled` 一起发，结果仍按原顺序检查：模板不符（`template_mismatch`）→ 版本已用（`version_used`）/ 不可读 → nonce 越界 → MEME deployer。所以多个读同时失败时，返回的错误与串行时一致。
- **单航班**：沿用 0155 在 `createHooksLaunchFactoryReader` 里加的共享 in-flight 网络 / code 校验，并发的几次读只下载一次 Factory code。
- **8 s 预算**：`hooksLaunchSigningRequestChainBudgetMs = 8_000`，请求开始（钱包 / 草稿读库之后、第一次链上读之前）记一个墙钟截止时间。第一批并发读与 `hookDeployment` 都在 `withinChainBudget` 内；`hookDeployment` 依赖挖出的 MEME salt，只能在挖矿之后读，挖矿耗时同样计入截止时间。超时抛 `HooksLaunchDeploymentError("unavailable")`，路由映射为既有的 503 `CAPABILITY_UNAVAILABLE` / `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`。
- **无副作用**：这条路径只读（钱包 / 草稿读库 + 链上读 + 本地挖 salt），不写库、不预留 nonce、不签名。超时时进程内的准入计数（最多 4 个并发准备）在 `finally` 释放；后台未完成的 RPC 由 viem 自身的 8 s/URL 超时结束，结果被丢弃。
- 测试接缝：`createHooksLaunchDeploymentService({ chainBudgetMs })`。

## 4. Consequences

- 慢或挂起的 RPC 下，签名请求最晚约 8 s（加最后一次挖 Hook salt 的本地计算）返回 503，客户端按既有 503 处理重试；不会再出现超时后服务端仍在跑的情况。
- 正常路径的响应内容不变；独立读并发后耗时从各读之和降为最慢的一个。
- 测试（`test/hooks-launch-deployment-crypto.test.ts`）：
  - 挂起的 `nonce` 读在预算内返回 `unavailable`、无写入，之后的请求能正常拿到准入槽；
  - 挂起的 `hookDeployment`（挖矿之后的读）同样在预算内结束；
  - 独立读全部开始后才有任何一个结束（并发）；串行要 ≥ 1,200 ms，会超出测试给的 1,150 ms 预算；
  - 并发后检查顺序不变：模板不符优先于版本已用和 nonce 失败；版本已用优先于 nonce 失败；nonce / token 失败为 `unavailable`。
- 范围外，同模块仍未设请求级上限的读链路径见 S229 交回清单（只列出，不在本次修改）。
