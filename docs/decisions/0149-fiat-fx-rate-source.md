# 0149 · 钱包「≈¥」汇率改为有来源的实时读取（S206-api，2026-10-16）

- Status: Accepted (S206-api)
- Date: 2026-10-16
- Baseline: `integration/v2` = `bf3b497`
- Revises: Decision 0145 §D `fiat`（`FIAT_CNY_PER_USD` 删除）
- Related: 0034 / 0057 / 0117（每个市场数字带 source / fetchedAt / quality）、0143 / 0145（worker lane 写法）
- Scope: 只在 `loop-api`。新增 migration `000088_fiat_fx_rates`（000087 属于 S205，二者无依赖）、worker lane `fiat_fx_rate`、Provider adapter `src/integrations/fx/frankfurter-adapter.ts`；`GET /v2/wallets/{walletId}/networth/history` 的 `fiat` 只增字段。不新增 npm 依赖、不新增能力位、不改 `ops/`。

## Context

0145 的 `fiat` 用 API 进程环境变量 `FIAT_CNY_PER_USD` 乘出人民币金额。用户指出：写死的汇率没有来源、不会更新，也没法告诉客户端它是哪天的数（用户原话：「汇率用 2，接一个真实的」）。这与 0034 / 0057 / 0117 的约定冲突——展示给用户的每个市场数字都应带 `source` / `fetchedAt` / `quality`。

## Decision

### 1. 来源：欧洲央行参考汇率，经 Frankfurter 读取

- 默认接口：`FIAT_FX_PROVIDER_URL = https://api.frankfurter.dev/v2/providers/ecb/rate/USD/CNY`（只取 ECB 一家，不用 Frankfurter 的多源 blended 值）。响应 `{"date":"2026-10-15","base":"USD","quote":"CNY","rate":6.691}`；`/rates?...` 的数组形式也接受（必须恰好一条匹配 USD/CNY）。
- 数据源：European Central Bank euro foreign exchange reference rates。工作日约 16:00 CET 更新一次，周末与 TARGET 假日不更新；USD/CNY 是 Frankfurter 按 ECB 的 EUR/USD、EUR/CNY 交叉算出的。
- 条款：
  - Frankfurter：免 key、无配额（仅防滥用限速）、明确允许商用与本地缓存/存储（<https://frankfurter.dev/>、FAQ）；代码 MIT；数据适用各 provider 自己的条款（<https://frankfurter.dev/license/>）。不收集个人数据。
  - ECB：参考汇率「仅供信息用途，强烈不建议用于交易」，ECB 对使用不承担责任（<https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html>、<https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html>）。我们只把它用于「≈¥」展示（0145：display information only，绝不参与余额、下单、风控），符合该用途；客户端应以 `source = ecb` 标注来源。
- 为什么选它：免 key（不引入新密钥）、官方央行参考价（可审计、可复现）、有正式文档与 OpenAPI、Frankfurter 已在 2026 年把 v1 标记 deprecated，因此直接用 v2 的 provider 路由（v1 的 `api.frankfurter.app/latest` 现在 301 到 `api.frankfurter.dev/v1`）。
- 备选：同一接口换成中国外汇交易中心人民币中间价 `https://api.frankfurter.dev/v2/providers/cfets/rate/USD/CNY`（CFETS central parity，每个交易日；条款 <https://www.chinamoney.com.cn/english/homflkdcm/>）。只改 env，adapter 与表不动，`source` 自动变为 `cfets`。再备选：直接读 ECB 的 `eurofxref-daily.xml`（需新写 XML 解析，未做）。
- `source` 从 URL 的 `/providers/{key}/` 取（小写）；URL 必须是 https、无用户名密码、且点名一家 provider，否则 worker 启动拒绝（blended 值没有单一来源，不允许）。

### 2. lane `fiat_fx_rate`（worker）

- env：`FIAT_FX_RATE_ENABLED`（默认 `true`）、`FIAT_FX_PROVIDER_URL`（默认见上）、`FIAT_FX_REFRESH_SECONDS`（默认 3600，60–86 400）。
- 启动即拉一次，之后每 `refresh` 秒一次。Node 内置 fetch（复用 market 的 `provider-http` 内核：8 s 超时、`redirect: "error"`、64 KB 上限、lossless JSON——汇率从不经过 JS `number`）。
- 校验：恰好一条 base/quote 匹配；`rate` 必须是十进制数字（lossless 解析下 JSON 数字与数字字符串不区分，均按原文校验）、无指数、> 0、≤ 1000、≤ 12 位小数（规范化去尾零）；`date` 必须是真实的 `YYYY-MM-DD`，且不晚于拉取日 + 1 天。任何一项不过即失败。
- 失败（不可达 / 超时 → `FIAT_FX_PROVIDER_UNREACHABLE`，非 200 → `FIAT_FX_PROVIDER_REQUEST_REJECTED`，429 → `FIAT_FX_PROVIDER_RATE_LIMITED`，畸形 → `FIAT_FX_PROVIDER_RESPONSE_MALFORMED`）：不写任何行，warn 一行带 `reasonCode`，60 s 后重试，连续失败翻倍，封顶 `refresh`。数据库错误按其它 lane 的 1 s → 60 s 退避。
- 写入：`fiat_fx_rates` 按 `(base, quote, source, provider_as_of)` upsert——同一 provider 日期只有一行，每次成功拉取刷新 `rate`（provider 可能修订）与 `fetched_at`（只往后走）。`quality`：拉取时 provider 日期已超过 5 天（ECB 最长连续休市 4 天）记 `stale`，否则 `fresh`。
- 日志只有 `lane`、`inserted`、`reasonCode`；不记 URL、响应体、汇率值。缺表（数据库未组装）打一行 `stays idle`（`FIAT_FX_RATE_UNAVAILABLE`）。

### 3. 表（migration 000088）

`fiat_fx_rates(base text, quote text, source text, provider_as_of date, rate numeric, fetched_at timestamptz, quality text, created_at)`，主键 `(base, quote, source, provider_as_of)`；check：币种三位大写且不同、`source ~ '^[a-z]{2,16}$'`、`0 < rate ≤ 1000`、`quality in ('fresh','stale')`；索引 `fiat_fx_rates_latest_idx (base, quote, provider_as_of desc, fetched_at desc)`。`down` 删表。`latestMigrationName` = `000088_fiat_fx_rates`，`requiredDatabaseRelations` 加上该表。无外键，不进集成套件的 truncate 清单。

### 4. 读取：history 的 `fiat`

每次请求读最新一行 USD/CNY（provider 日期最新、再按拉取时间）：

```json
"fiat": {
  "currency": "CNY",
  "rate": "6.691",
  "amount": "42506.69",
  "source": "ecb",
  "asOf": "2026-10-15",
  "fetchedAt": "2026-10-16T04:00:00.000Z",
  "quality": "fresh"
}
```

- `rate`：1 USD 兑多少 CNY，十进制字符串。`amount = current.netWorthUsd × rate`，2 位，四舍五入（half away from zero，沿用 0145）。
- `source`：provider key（默认 `ecb`）。`asOf`：provider 的观测日期（`YYYY-MM-DD`，OpenAPI `format: date`；它是日期不是时刻）。`fetchedAt`：最近一次成功拉取。
- `quality`：`fresh` = 存的是 `fresh` 且 `fetchedAt` 距响应时刻 ≤ 26 小时；否则 `stale`（仍给出最后一条的数和金额，客户端可以弱化显示）。
- 表里没有任何 USD/CNY 行、表未组装、或这次读失败 → `fiat: null`（与 0145「汇率没有来源就不画那一行」一致）；汇率读失败**不**让整个 history 503。
- 其他字段不变。仓库里除 history 外没有别处读 `FIAT_CNY_PER_USD`。

### 5. 删除 `FIAT_CNY_PER_USD`

从 `config.ts`（schema、`AppConfig.fiatCnyPerUsd`、解析函数）、`.env.example`、`docs/api-inventory.md` 删除；API 进程不再读它，残留在某个 env 文件里的旧值被忽略（不会让启动失败）。0145 §D 的 `fiat` 段以本决策为准。

## Consequences

- 首次部署后、lane 第一次成功之前，`fiat` 为 `null`（行为与未配 env 时相同）。worker 需要出网访问 `api.frankfurter.dev`。
- 移动端：`fiat` 多了四个必填字段（只增不改）；`asOf` 是日期字符串；`quality = stale` 时建议在「≈¥」旁标注或弱化。
- 迁移号：000087 由 S205 占用，本批用 000088。两批合并后 `latestMigrationName` 应为二者中较大的 000088；若 000088 先于 000087 在某个库上执行，node-pg-migrate 的顺序检查会拒绝之后补跑 000087——部署时先合并 S205 再上本批，或按号顺序一起迁移。
- 运维：`ops/*.env` 未改；若其中有 `FIAT_CNY_PER_USD`，可删可留（被忽略）。

## Tests

- 单测 `test/fiat-fx-rate.test.ts`：adapter 正常（对象与数组两种形式、lossless 精度、请求头）/ 15 种畸形 / 422、500、429、不可达 / 超时中止；`canonicalFiatFxRate` 边界与 URL 推 source；lane 成功写入的字段、provider 日期过旧记 stale、未来日期拒绝、失败不写并回报 reasonCode、provider 失败退避序列（60 s 起翻倍封顶 1 h）、`run` 循环的 provider / 数据库两种退避；`projectFiat` 的 fresh / 26 h 边界 / stale / null 与舍入；service 每次读最新、读失败为 null；worker env 默认值、关闭、换 CFETS、六种非法值启动拒绝。
- 契约 `test/v2-chain-wallet-routes.test.ts`：完整文档的 `fiat` 七个字段（经 `buildApp` 与 OpenAPI 响应 schema），汇率读失败时 200 + `fiat: null`。
- `test/wallet-networth-snapshot.test.ts`：残留的 `FIAT_CNY_PER_USD` 被忽略、`AppConfig` 无 `fiatCnyPerUsd`。
- 集成 `test/fiat-fx-rate.integration.test.ts`（一次性库）：七种越界行被 check 拒绝；lane 经真实仓储写入、同一 provider 日期 upsert 为一行并刷新 `fetched_at`、畸形 / 503 不写、新日期成为最新；history `fiat` 无行 null → fresh（金额 8260.49）→ 26 h 边界 fresh → 超过 stale；000088 down / up 与索引形状。
- 各「最新迁移」断言改为 `000088_fiat_fx_rates`；`test/database-schema.test.ts` 关系清单同步；`pnpm openapi:check` 已重生成。
- `test/reconciliation-worker-config.test.ts` 默认配置快照加 `fiatFxRate`；`test/reconciliation-worker-process.integration.test.ts` 设 `FIAT_FX_RATE_ENABLED=false`（测试进程不出网）；lane 被关停中断的那次读取不报失败。`scripts/dev-reset-users.ts` 把 `fiat_fx_rates` 归为 `platform`；worker 日志 lane 白名单加 `fiat_fx_rate`。
- 门禁在一次性库 `loop_api_test_s206` 上跑（结束已 drop）：单测 320 文件全过（两个既有用例偶发 5 s 超时，单独复跑通过），集成 80 套件 / 730 条全过。
