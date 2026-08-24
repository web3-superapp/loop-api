# LOOP 全 App 成熟能力复用目录候选

> **历史调研与页面清单，不是当前实施授权。** 当前供应商口径以仓库根目录
> `README.md` 与 `docs/product-decisions.md` 为准：通信选用 Stream Chat +
> Stream Video/Audio Rooms，但尚无 live SDK/runtime/endpoint；Pay 不在本期，
> 后端不得实现支付；风险展示只能使用带来源与时间的可验证事实，不给 AI
> Guard 或数值风险分背书。目录中 Pay、MoonPay、AI Guard 等记录仅保留迁移
> 追溯，不得据此启动实现。

本目录是 LOOP App A–I 的“整 App 成熟业务能力与代码复用合同”，不是 UI 组件清单，也不安装或导入任何 SDK。`screen-inventory.json` 固定来自 `文档/页面清单.md` v1.4 的 103 个页面（A 档 47、B 档 46、C 档 10）；`catalog.json` 将每个页面映射到能力 profile、主权威、官方接口、成熟复用项、薄适配器所有权、凭据类别、离线 fixture、失败语义和替换门。无法从官方文档、canonical GitHub 仓库和 registry 同时闭合的时效信息统一标为 `PENDING`，不得猜版本、能力或许可证。

`GitHub 复用`在机器合同中的唯一含义是成熟的应用级业务能力、托管服务或其官方 SDK/高维护 OSS core；UI component library、screen template、demo/example app 都不能计入 whole-app reuse 交付。未知许可代码禁止复制。候选 identity、exact tag/commit、许可、部署、维护、出口和 credentialed gate 可以先锁定，但候选不等于 runtime；9 个 selection gate 的 `runtime_selected` 在正式评审前都必须为 `null`。

## 不可变主权边界

- 钱包身份、embedded wallet、签名和 Wallet Actions 的主权威是 Privy。LOOP 不保存私钥，不写 signer、钱包 core、swap router 或 bridge router。
- 通信的主权威是 Stream Chat/Video。LOOP 只做 token BFF、权限映射、稳定 ID attachment 和状态投影，不写 IM transport、RTC media 或 SFU。
- Perp 的主权威是 Hyperliquid，范围只限 core-whitelist markets；`HIP-3` 始终禁止。只读 market/funding 与 trading mutations 是两个 profile；D2–D10、D12 的 mutation/资金/桥流程必须传播 regional/legal/eligibility `PENDING`，地区未知时 fail closed。LOOP 不写撮合、账本、市场数据源或替代 signer。

`custom_code_budget` 只允许 LOOP 差异化的 `ui`、`orchestration`、`state_projection`、`policy_mapping`、`thin_adapter` 和 `copy`。任何 provider/OSS core 缺口都不能以复制、fork 或自行实现来绕开；例外必须先保持 `PENDING`，提供 provider gap、成本、安全、维护和替换证据，并取得书面批准。

## 整 App 业务 core 选择门

profile/social graph、following/follower/blocklist、watchlist、durable notification inbox/preferences、price-alert scheduler、provider-event ingestion、activity feed、federated search/indexing 和 support ticket core 不能默认落到 LOOP BFF。它们由 `provider-lock.json#capability_selection_gates` 逐项设为 `PENDING/default-deny`：只有完成官方 provider 或维护良好 GitHub OSS 的 canonical identity、exact release/integrity、license、maintenance、security/privacy、migration/export 与 credentialed conformance 证据后，才可成为 runtime。Riverpod 仅用于客户端投影，PostHog 仅用于 analytics，FCM 仅用于 delivery；三者都不能冒充 durable persistence、authz、scheduler、event ingestion 或 indexing core。

在选择门关闭前，对应 slice、依赖 slice、profile 和 103 页面 mapping 必须沿 DAG 闭包保持 `PENDING`。LOOP 可提前实现的仍只有 UI、orchestration、state projection、policy mapping、thin adapter 与 copy，不得提前落地自有 social graph、watchlist store、notification inbox、alert scheduler、feed、search index、event bus、job scheduler、authorization core 或 support backend。

v6 候选锁覆盖 Supabase、Novu、Courier、Trigger.dev、Hookdeck、Meilisearch、Chatwoot 与 Stream Feeds。Novu/Courier 只进行单一 notification runtime 的对比 spike，`runtime_selected=null`；不得双写运行。Stream Feeds Flutter 尚为 closed alpha，`relationship_graph` 与 `activity_feed` 必须保持 `PENDING_MUST_REMAIN`，不能仅凭仓库活跃或已有界面提前声称 GA。

Chatwoot server v4.17.0 是明确的 mixed-license boundary：`enterprise/**` 以外的 community code 按根目录 MIT Expat 条款，`enterprise/**` 受独立 Chatwoot Enterprise License 约束，第三方组件仍保留各自许可；不得把整个 server 写成 MIT。Flutter 客户端是独立 candidate component，不计为应用级候选。canonical `chatwoot/chatwoot-flutter-sdk` 没有 tag/release；pub.dev `chatwoot_sdk@0.0.9` archive 与仓库 HEAD 虽声明同一版本，但 Dart 约束和内容发生漂移，缺少不可变 archive→commit 绑定。因此它只允许为 `PENDING_ARTIFACT_SELECTION`，support gate 继续 default-deny，合同不声称存在 official/ready Flutter integration。

Hookdeck 只允许作为 **untrusted reliability ingress**：接收、排队、无损路由、限流、传输重试/回放与观测。它不得自称替 Privy/Stream 做 provider-specific cryptographic verification。raw body bytes 与所需 headers 必须先通过逐字节无损 conformance，再进入最薄 provider verifier BFF，按当前官方算法/SDK完成 signature 以及官方合同要求的 timestamp/replay 校验。验证前 payload 不可信、不得 transform、不得产生业务 side effect；Hyperliquid WebSocket 走独立官方 adapter。

## 关键退出与失败规则

Alchemy Transaction Simulation 已确认 2026-09-30 移除，因此 provider lock 明确标为 `deprecated_no_new_integration`，只保留审计记录，不能成为任何 profile 的新接入或上线依赖。交易 preview 只接受通过 exact capability audit 的 Privy 官方能力，或 credentialed Blockaid provider；当前二者均为 `PENDING`。preview 不可用时显示 `preview_unavailable` 并应用已批准的 `approved_request_kind_policy`：eligible transfer/approval 可在清晰披露后经显式强确认继续；sanctions blocked/unavailable、stale、malformed、material mismatch 和未知请求种类仍 fail-closed。绝不自建交易模拟器。

F11 使用独立 `unified_intent_review_composition`：Privy 始终是唯一签名权威，LOOP 只组合 transfer、swap/bridge、approval、DApp/provider facts 和 request-kind policy。F7/F15/F16/F17 等仍由各自 provider profile 生产事实或 action payload，再进入统一审阅；fixture 不声称 provider simulation 成功。

MoonPay 仅作为 signed hosted widget/WebView 候选，Flutter 支持、KYB、回跳、相机和商店审核未闭合，保持 `PENDING`；Transak 官方文档已说明 Flutter 不受支持，因此不进入候选。Chainalysis 只用于 sanctions boundary，不能冒充通用地址风险分。TradingView Lightweight Charts 是 JavaScript renderer 候选，不是 Flutter renderer；C2/C3/Perp chart 必须显式依赖审计后的 WebView bridge，并在闭环前保持 `PENDING`。Advanced Charts 还需私有许可证。

`provider-lock.json` 是 provider/OSS identity、canonical GitHub repository、runtime pin、upgrade candidate、应用级候选、依赖 component、版本、tag、commit、artifact/license integrity、maintenance evidence 与 capability selection gate 的唯一机器可读真相。46 个 provider 记录、8 个 application candidate、1 个 dependency component 和 9 个 selection gate 都由 verifier 的 exact ID set 与 canonical digest 锁定；任意伪版本、伪 URL、伪 commit/hash、`latest`/branch pin、依赖漏 pin/伪 pin、许可边界坍缩、未知许可复制或额外记录都失败。`archive:<exact-member-path>` 表示 archive 内逐字匹配的真实成员路径，不剥离 sdist 顶层目录、不做 basename/fuzzy 查找；verifier 会从 byte-locked artifact 中实际读取该成员，并复算 artifact 与 license hash。profile 只允许引用已批准的 `runtime_selected_pin`；候选和 registry 最新版不能成为 runtime，未经对应 slice 的 diff、依赖图、license、migration/export、conformance 与 credentialed R0 不得替换。

`offline-fixtures.json` 的网络固定为 forbidden，凭据省略、mutation 禁用，并且不得回落到生产；fixture 只演示界面和状态，不可作为 provider 成功证据。`implementation-slices.json` 按 wave 和独立文件所有权排序，同 wave 可并行，但每个 slice 仍需通过各自 credentialed R0/R1 gate。任何 `PENDING` 依赖都会传递到 profile 和页面映射，禁止用 fixture、mock 或乐观状态伪装 READY。

原型仓库曾用 `_tmp/verify_integration_catalog.py` 与
`_tmp/integration-catalog-provenance/` 验证这些锁，并检查当时的 `app.js` 和
`build.py`。这些路径没有迁入 `loop-api`，只能作为历史验证来源名称，不能
写进当前 CI、runtime 或发布命令。本目录目前没有可运行的 catalog verifier；
若重新启用任何候选，必须在新仓建立可追踪的验证入口，而不是假定旧命令仍然
存在。
