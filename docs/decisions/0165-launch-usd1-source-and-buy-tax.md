# 0165 · Launch USD1 取 Hooks 工厂 `usd1()`、外盘 USD1 计税买入意图的 `taxUsd1`（S246-api，2026-10-19）

## 1. Status

已实现（分支 `fix/S246-launch-usd1-and-buy-tax`，基线 `40921be`）。无迁移、无 SQL 变化、无新错误码、无新字段。OpenAPI 只改 `GET /v2/wallets/{walletId}/balances` 中 `launchChain.usd1` / `launchUsd1` 的描述文字。来源：S237 真机验收（`docs/integration/S237/notes.md`，loop-mobile 决策 0208）。

## 2. Context

- **A**：钱包余额的 `launchChain.usd1`（共享槽时根 `launchUsd1`）用 env `LAUNCH_USD1_ADDRESS` 作代币地址。staging / dev 这个值指向旧 IDO 的 MockUSD1（`0x17d5…ce2b`），而 MEME v2、水龙头（决策 0128 / S156b）、买入面板用的是 Hooks 工厂 `usd1()`（staging `0x3a12…0195`），用户的余额在后者，钱包页因此显示 0。
- **B**：LoopDynamic 外盘 `pool/trade/prepare` 生成意图时写死 `tax: side === "sell" ? tax : 0n`。S209 Hook 的买入税以 USD1 收（`buyFeeToken = usd1`，loop-contracts 决策 0015 §3、本仓库决策 0152），报价的 `taxUsd1` 已正确（如 10 USD1 → 0.2），但意图的 `taxUsd1` 为 0，签名单显示「外盘税 2% · 0 USD1」，与报价不一致。

## 3. Decision

### A. USD1 代币来源

- `HooksLaunchFactoryReader` 新增可选 `usd1()`：先做既有的网络 / Factory code 校验，再读 `usd1()`；返回小写地址，零地址或非法值抛错（fail closed）；首次成功后在 reader 内缓存（工厂 code hash 已钉住，`usd1()` 不可变；与水龙头 `resolveUsd1` 同一规则）。
- `createWalletReadService` 新增输入 `launchUsd1Token`。`app.ts` 在 Hooks 工厂 reader 组装后（`HOOKS_LAUNCH_ENABLED=on` 且工厂 + code hash + launch 槽 RPC 齐备；OfficialTax 或 LoopDynamic，按 `HOOKS_LAUNCH_HOOK_KIND`）把它指向 `reader.usd1()`；没有工厂时返回 env `LAUNCH_USD1_ADDRESS`。
- 每次余额请求：
  - 未配置 Launch 合约四键（`launchUsd1` 目标为 null）→ 与之前一样不读 USD1、块缺省；
  - 有工厂 → 代币 = 工厂 `usd1()`（3 s 期限，与 launch 槽读同一常量），读失败 / 超时 → `usd1` / `launchUsd1` 缺省，记 degraded leg `launchUsd1Token`，**不回退** env 代币（错的代币比缺省更糟）；native 余额不受影响；
  - 无工厂 → env `LAUNCH_USD1_ADDRESS`（原行为）。
- `allowance` 的 spender 不变，仍是 `LAUNCH_CONTRACT_ADDRESS`。响应形状不变（`{balance, allowance}`）。

**IDO 授权**：App `launch_approval.dart` 也读 `launchChain.usd1`（旧 IDO 合约的授权额）。IDO 已隐藏（`idoLaunchVisible=false`），本批不为它保留旧代币。若将来恢复 IDO 且其 USD1 与工厂 `usd1()` 不同，应另给字段（如 `launchChain.idoUsd1`）承载旧代币的余额 / 授权，本批不做。MEME v2 买入的授权以 launch2 意图的 `approval` 为准，不读这里的 `allowance`。

### B. 买入意图的 `taxUsd1`

- `dynamicPoolQuoteAt` 返回 `buyFeeToken`；`prepareDynamicPoolTrade` 的意图 `tax` 改为 `side === "sell" || buyFeeToken === "usd1" ? numbers.tax : 0n`。`numbers.tax` 就是报价 `taxUsd1` 的同一个值（`floor(amountIn × buyFeePpm / 1e6)`），同源同精度。
- MEME 计税买入（S165 Hook、OfficialTax 官方池）仍为 0；卖出不变；OfficialTax 官方池路径（`taxToken` 买入恒为 `meme`）不动。

## 4. Consequences

- staging / dev 无需改 env 即生效：只要 Hooks 工厂已组装，钱包 USD1 就读工厂代币。运维说明：`LAUNCH_USD1_ADDRESS` 可以切到工厂 `usd1()` 地址，但不再必需；它仍是 Launch 合约四键之一（四键全空或全填），仍是没有工厂时的回退，也仍被水龙头在既无显式地址也无工厂时使用。
- 首次请求多一次工厂 code 校验 + `usd1()` 读（≤ 3 s 期限，与 launch 槽读并行开始）；之后命中缓存，无额外 RPC。
- 签名单的 USD1 税与报价一致；意图记录 `taxUsd1` 对 S209 买入不再为 0。
- 测试：
  - `test/v2-chain-wallet-routes.test.ts`：工厂在 → 余额 / 授权读工厂代币、spender 为 Launch 合约、工厂 `usd1()` 只读一次；工厂读失败 → `usd1` 缺省、native 仍 available、未读 env 代币；无工厂（`HOOKS_LAUNCH_ENABLED=off`）→ 回退 env 地址。
  - `test/hooks-launch-factory-reader-usd1.test.ts`：`usd1()` 小写、缓存；零地址 fail closed 且不缓存。
  - `test/v2-launch2-dynamic-routes.test.ts`：S209 Hook 买入意图 `taxUsd1 = "0.2"` = 报价 `taxUsd1`；S165 买入意图 `taxUsd1 = "0"`。
