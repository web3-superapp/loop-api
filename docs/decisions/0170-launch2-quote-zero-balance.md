# 0170 · 内盘报价：余额为 0 不再答「报价已变化」+ 请求日志带 reasonCode（S266-api，2026-10-21）

## 1. Status

已实现（分支 `fix/S266-quote-zero-balance`，基线 `integration/v2` `ceda2a7`）。无迁移、无新路径、无新响应键、无新 env。只改错误分支与日志。

## 2. Context

- 需求方新钱包（测试网 USD1 余额 0、从未买过）在 MEME v2 内盘点买入：`GET /v2/launch2/instances/:id/quote` 答 `409 DATA_STALE / LAUNCH2_QUOTE_ZERO`，App 显示「报价已变化，请重新报价」，买入按钮灰，也看不到领取测试币入口。
- 根因：`launch2Max` 在 `balance < maxUsd1In` 时按余额封顶，余额 0 → `memeOut 0` → `amountIn 0`、`limitedBy: "balance"`；`service.quote` 对 `max.amountIn === 0n || expectedOut === 0n` 只区分 quota / inventory，其余一律 `quoteZero`。内盘 `trade/prepare` 同一情形更糟：`max.amountIn === 0n` 且非 quota 一律 `LAUNCH2_SOLD_OUT`。
- 「Request failed」日志只有 `responseCode / errorCode / statusCode`，同一个 409 背后的 reasonCode 只能靠猜。

## 3. Decision

### A. 余额导致的空报价 = `409 INSUFFICIENT_BALANCE`

在 `service.quote` 与曲线 `trade/prepare` 里，`max.amountIn === 0n || expectedOut === 0n` 时先判：

- `max.limitedBy === "balance"`，且
- `max.amountIn === 0n`（余额 0，或余额不够一个最小 MEME 单位的价格），或请求被封顶到余额后 `expectedOut === 0n`

→ `409 INSUFFICIENT_BALANCE`，`reasonCode` 买 = `LAUNCH2_USD1_BALANCE_INSUFFICIENT`、卖 = `LAUNCH2_MEME_BALANCE_INSUFFICIENT`；`detailsSafe` 只用决策 0129 已有字段：`maxAmountIn`（= 余额）、`requiredAmountIn`（= 请求的 amount）、`balanceUsd1` / `balanceMeme`。

其余空报价不变：quota → `LAUNCH2_QUOTA_EXHAUSTED`，inventory → `LAUNCH2_SOLD_OUT`，请求额小于余额但算出 0（金额过小）→ 仍是 `DATA_STALE / LAUNCH2_QUOTE_ZERO`（`limitedBy` 照旧）。

quote 路由的 409 响应 schema 由 `launch2ReadErrors` 换成 `launch2QuoteErrors`（多一个 `INSUFFICIENT_BALANCE`），描述补上两种 reasonCode 与 `LAUNCH2_QUOTE_ZERO`。

### B. 「Request failed」日志带 `reasonCode`

`/v2` 错误处理器的 warn 行从投影后的 `detailsSafe` 里只取白名单字符串键 `reasonCode`、`limitedBy`、`stage`，与 `responseCode` 同行。`detailsSafe` 不整体入日志（含余额等金额）。

## 4. Consequences

- 客户端不需改 codec：`INSUFFICIENT_BALANCE`、两个 reasonCode、`maxAmountIn / requiredAmountIn / balanceUsd1 / balanceMeme` 都已在 loop-mobile `launch2_format.dart`（401 行文案表、487–533 行 `launch2ActionFailure`）识别；余额不足会带 `topUp: true`。是否在报价阶段（而非 prepare 阶段）把这个错误接进 `launch2ActionFailure` 并显示领取测试币入口，由 App 侧确认。
- 已发布 App 若在报价阶段只认 `DATA_STALE`，会把新的 409 当通用错误显示；不会再显示误导的「报价已变化」。
- 日志里多 1–3 个短字符串字段，无金额、无地址。
