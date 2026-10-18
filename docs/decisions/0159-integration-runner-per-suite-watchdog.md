# 0159 · 集成测试 runner 逐套件进程 + 看门狗（S228-api，2026-10-18）

## 1. Status

已实现（分支 `fix/S228-integration-hang`，基线 `aefffe0`）。只改测试基础设施：`scripts/run-integration-tests.ts`、`test/helpers/anvil.ts`、8 个 `*anvil*.integration.test.ts` 的 `afterAll`、`docs/local-development.md`。无迁移、无业务代码、无 OpenAPI 变化，未放宽任何断言。

## 2. Context

S226 跑 `pnpm test:integration` 时 13 分钟零输出，看上去卡在某个空闲的 anvil 套件。

复现（旧 runner，只跑 8 个 anvil 套件）：8 分 16 秒零输出，最后 `8 passed / 21 passed`。用 inspector 连上 worker，当时在跑 `launch2-pool-anvil` 的「official-pool buys and sells」用例（声明超时 30 分钟），anvil 0% CPU、没有 pending 交易——是在正常推进，不是死锁。

根因：

1. **不是死锁，是"看不见"**。旧 runner 把全部套件塞进一个 vitest 进程；vitest 4 默认 reporter 在非 TTY（子代理 / 管道）下只在结尾打汇总，中途不输出任何东西。全量本身约 13 分钟（`launch2-buyback-keeper-anvil` 138s、`launch2-pool-anvil` 115s），所以表现为"13 分钟零输出"，无法区分慢和挂。
2. **真挂了也没有兜底**。没有整体墙钟上限；anvil 套件的 `beforeAll` 声明 900s、单测最长 1 800s，`forge script` 用 `spawnSync`（阻塞事件循环，vitest 超时在此期间无法触发）；runner 不知道当前跑到哪个套件。
3. **清理有漏洞**。`afterAll` 先 `pool.end()` 再 `chain.stop()`：`beforeAll` 中途失败（pool 未建）时 `pool.end()` 抛错，anvil 不会被停掉，worker 退出后成为孤儿进程；`chain.request` 的 `fetch` 没有超时；`stop()` 只看 `exitCode`，被信号杀掉的 anvil 会白等 3 秒。

## 3. Decision

runner：

- 每个套件一个 vitest 进程，**串行**（38 个套件共用 `DATABASE_URL_TEST` 并 truncate，不能并行）；`--maxWorkers=N` 等以 `-` 开头的参数透传给 vitest，只影响单个套件内部。
- 每个套件在独立进程组（`detached`）里跑；开始打 `▶ [i/N] file`，结束打 `✔/✖ … passed|failed|timed out (Ns)`，运行中每 60 秒打一次 `… still running (Ns)`。
- 墙钟预算 `INTEGRATION_SUITE_TIMEOUT_MS`（默认 20 分钟，大于任何 anvil 套件声明的单测超时）。超时即打印 `TIMED OUT`、`SIGKILL` 整个进程组（vitest、fork worker、anvil、forge），然后继续下一个套件。每个套件结束后也清一次进程组，回收遗留子进程。
- 加 `--teardownTimeout=10000`；结尾一行 `test:integration summary: X passed, Y failed, Z timed out of N suites in Ts`，并逐个列出未通过的套件；有任何失败或超时则退出码 1。

anvil helper：

- 记录本 worker 启动的全部 anvil；新增 `stopAnvilChains()`，`afterAll` 改为 `try { pool.end() } finally { stopAnvilChains(); drop database }`，`beforeAll` 半途失败也能停链、删库。
- `process.once("exit")` 兜底 `SIGKILL` 所有未停的 anvil。
- 每个 JSON-RPC 请求 30s `AbortSignal.timeout`；启动轮询发现 anvil 已退出立即失败；`stop()` 同时看 `exitCode` / `signalCode`。

## 4. Consequences

- 全量 83 个套件实测 811s 跑完（含每套件进程启动开销），任何挂起都会在 20 分钟内被点名并终止，不再静默。
- 单套件调试不变：`pnpm test:integration test/<file>.integration.test.ts`。
- 未处理：`forge script` 的 Foundry 产物目录仍是共享的 `$TMPDIR/loop-hooks-executor-forge`；多个代理同时跑 anvil 套件会并发写同一 out/cache，建议错开（与本机只跑一份 vitest 的约定一致）。
