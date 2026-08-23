# LOOP 全 App 成熟能力复用目录候选

本目录是 LOOP App A–I 的“整 App 成熟业务能力与代码复用合同”，不是 UI 组件清单，也不安装或导入任何 SDK。`screen-inventory.json` 固定来自 `文档/页面清单.md` v1.4 的 103 个页面（A 档 47、B 档 46、C 档 10）；`catalog.json` 将每个页面映射到能力 profile、主权威、官方接口、成熟复用项、薄适配器所有权、凭据类别、离线 fixture、失败语义和替换门。无法从官方文档、canonical GitHub 仓库和 registry 同时闭合的时效信息统一标为 `PENDING`，不得猜版本、能力或许可证。

## 不可变主权边界

- 钱包身份、embedded wallet、签名和 Wallet Actions 的主权威是 Privy。LOOP 不保存私钥，不写 signer、钱包 core、swap router 或 bridge router。
- 通信的主权威是 Stream Chat/Video。LOOP 只做 token BFF、权限映射、稳定 ID attachment 和状态投影，不写 IM transport、RTC media 或 SFU。
- Perp 的主权威是 Hyperliquid，范围只限 core-whitelist markets；`HIP-3` 始终禁止。只读 market/funding 与 trading mutations 是两个 profile；D2–D10、D12 的 mutation/资金/桥流程必须传播 regional/legal/eligibility `PENDING`，地区未知时 fail closed。LOOP 不写撮合、账本、市场数据源或替代 signer。

`custom_code_budget` 只允许 LOOP 差异化的 `ui`、`orchestration`、`state_projection`、`policy_mapping`、`thin_adapter` 和 `copy`。任何 provider/OSS core 缺口都不能以复制、fork 或自行实现来绕开；例外必须先保持 `PENDING`，提供 provider gap、成本、安全、维护和替换证据，并取得书面批准。

## 整 App 业务 core 选择门

profile/social graph、following/follower/blocklist、watchlist、durable notification inbox/preferences、price-alert scheduler、provider-event ingestion、activity feed、federated search/indexing 和 support ticket core 不能默认落到 LOOP BFF。它们由 `provider-lock.json#capability_selection_gates` 逐项设为 `PENDING/default-deny`：只有完成官方 provider 或维护良好 GitHub OSS 的 canonical identity、exact release/integrity、license、maintenance、security/privacy、migration/export 与 credentialed conformance 证据后，才可成为 runtime。Riverpod 仅用于客户端投影，PostHog 仅用于 analytics，FCM 仅用于 delivery；三者都不能冒充 durable persistence、authz、scheduler、event ingestion 或 indexing core。

在选择门关闭前，对应 slice、依赖 slice、profile 和 103 页面 mapping 必须沿 DAG 闭包保持 `PENDING`。LOOP 可提前实现的仍只有 UI、orchestration、state projection、policy mapping、thin adapter 与 copy，不得提前落地自有 social graph、watchlist store、notification inbox、alert scheduler、feed、search index、event bus、job scheduler、authorization core 或 support backend。

## 关键退出与失败规则

Alchemy Transaction Simulation 已确认 2026-09-30 移除，因此 provider lock 明确标为 `deprecated_no_new_integration`，只保留审计记录，不能成为任何 profile 的新接入或上线依赖。交易 preview 只接受通过 exact capability audit 的 Privy 官方能力，或 credentialed Blockaid provider；当前二者均为 `PENDING`。preview 不可用时显示 `preview_unavailable` 并应用已批准的 `approved_request_kind_policy`：eligible transfer/approval 可在清晰披露后经显式强确认继续；sanctions blocked/unavailable、stale、malformed、material mismatch 和未知请求种类仍 fail-closed。绝不自建交易模拟器。

F11 使用独立 `unified_intent_review_composition`：Privy 始终是唯一签名权威，LOOP 只组合 transfer、swap/bridge、approval、DApp/provider facts 和 request-kind policy。F7/F15/F16/F17 等仍由各自 provider profile 生产事实或 action payload，再进入统一审阅；fixture 不声称 provider simulation 成功。

MoonPay 仅作为 signed hosted widget/WebView 候选，Flutter 支持、KYB、回跳、相机和商店审核未闭合，保持 `PENDING`；Transak 官方文档已说明 Flutter 不受支持，因此不进入候选。Chainalysis 只用于 sanctions boundary，不能冒充通用地址风险分。TradingView Lightweight Charts 是 JavaScript renderer 候选，不是 Flutter renderer；C2/C3/Perp chart 必须显式依赖审计后的 WebView bridge，并在闭环前保持 `PENDING`。Advanced Charts 还需私有许可证。

`provider-lock.json` 是 provider/OSS identity、canonical GitHub repository、runtime pin、upgrade candidate、版本、tag、commit、artifact/license integrity、maintenance evidence 与 capability selection gate 的唯一机器可读真相。46 个 provider 记录和 9 个 selection gate 都由 verifier 的 exact ID set 与 canonical digest 锁定；任意伪版本、伪 URL、伪 commit/hash 或第 47 项都失败。`archive:<exact-member-path>` 表示 archive 内逐字匹配的真实成员路径，不剥离 sdist 顶层目录、不做 basename/fuzzy 查找；verifier 会从 byte-locked artifact 中实际读取该成员，并复算 artifact 与 license hash。profile 只允许引用已批准的 `runtime_selected_pin`；registry 最新版只能另列 `upgrade_candidate_pending_slice_audit`，未经对应 slice 的 diff、依赖图、license、conformance 与 credentialed R0 不得替换。

`offline-fixtures.json` 的网络固定为 forbidden，凭据省略、mutation 禁用，并且不得回落到生产；fixture 只演示界面和状态，不可作为 provider 成功证据。`implementation-slices.json` 按 wave 和独立文件所有权排序，同 wave 可并行，但每个 slice 仍需通过各自 credentialed R0/R1 gate。任何 `PENDING` 依赖都会传递到 profile 和页面映射，禁止用 fixture、mock 或乐观状态伪装 READY。

验证入口是 `_tmp/verify_integration_catalog.py`。它绑定 canonical 103 每项的 exact id/module/priority/name/surface/route/state/profile/owner、exact 46 provider records、exact 32 profiles、exact 9 selection gates，并检查精确 14 slices、DAG/PENDING 闭包、拓扑 wave、prefix ownership、authority/reuse/custom gap、GitHub/official identity、license/integrity/source、凭据、R0、fail-closed 和恶意 mutations。Hyperliquid Python 的 exact upstream sdist 作为只读 provenance artifact 放在 `_tmp/integration-catalog-provenance/`，verifier 实际解析 exact license member；它不访问网络、不导入 SDK，也不修改 `app.js` 或 `build.py`。
