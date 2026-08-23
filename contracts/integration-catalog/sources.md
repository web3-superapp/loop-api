# 官方来源与单一锁定真相

复核日期为 2026-08-23。`provider-lock.json is the single machine-readable pin truth`：所有 provider/OSS canonical identity、GitHub repository、runtime-selected pin、upgrade candidate、版本、tag、commit、registry integrity、license integrity、maintenance evidence、状态与选择/升级门只在该文件出现。本页仅列官方来源与能力边界，不重复任何可漂移的精确 pin。无法从官方文档、registry 和 canonical repository 闭合的能力保持 `PENDING`。

`custom_code_budget` 继续约束全 App：Privy 是 wallet/signature authority，Stream 是 Chat/Video communication authority，Hyperliquid 是 core-whitelist Perp authority；`HIP-3` 禁止。成熟 provider/OSS core 不得复制、fork 或在 LOOP 内重写。

机器策略明确规定：GitHub 复用必须是成熟应用级业务能力、托管服务、官方 SDK 或高维护 OSS core；UI component、screen template、demo/example app 不能冒充 whole-app reuse。任何未知许可代码都禁止复制，候选在 selection gate 关闭前不是 runtime。

## 整 App core 的 provider-selection 边界

Social/profile/relationship graph、watchlist persistence、notification inbox/preferences、price-alert scheduler、provider-event ingestion、activity feed、federated search/indexing 和 hosted support 都必须先通过逐项 `provider_selection_gate=PENDING/default-deny`。当前未严谨选定 provider/OSS，所以没有任何自有 LOOP BFF core 获准实现。候选必须同时给出 official identity 或 canonical GitHub owner/repository、exact release 与 integrity、license、maintenance、安全/隐私、迁移/export 和 credentialed conformance 证据。

Riverpod 只承担客户端 state projection，PostHog 只承担 analytics，FCM 只承担 delivery。它们不是 durable store、authorization engine、event ingestion、scheduler、inbox、feed 或 search index。依赖未关闭选择门的 slice/profile/page 会沿 exact 14-slice DAG 闭包传播 `PENDING`。

## v5 应用级候选来源

- Supabase：<https://github.com/supabase/supabase>；Flutter/RLS：<https://supabase.com/docs/guides/getting-started/quickstarts/flutter>；Cloud 到 self-host restore：<https://supabase.com/docs/guides/self-hosting/restore-from-platform>。只承接 Privy DID 扩展资料、watchlist 和 alert definitions，不启用 Supabase Auth，也不成为行情事实权威。
- Novu：<https://github.com/novuhq/novu>；tenant authorization advisory：<https://github.com/novuhq/novu/security/advisories/GHSA-wjx8-c9gq-37gg>。没有官方 Flutter Inbox SDK，因此只做最薄 REST/WebSocket adapter 的 P0 维护成本 spike。
- Courier Flutter：<https://www.courier.com/docs/sdk-libraries/flutter>；canonical SDK repository：<https://github.com/trycourier/courier-flutter>；message-log retention：<https://www.courier.com/docs/platform/analytics/message-logs>。官方 Flutter SDK 可作 Novu 的托管对比项，但 artifact provenance、Flutter dependency、JWT rotation 和 bulk export 仍未闭合。
- Trigger.dev：<https://github.com/triggerdotdev/trigger.dev>；schedules：<https://trigger.dev/docs/tasks/scheduled>；idempotency：<https://trigger.dev/docs/idempotency>。只调度和重试，不能生成、覆盖或推断 CoinGecko、DEX Screener、Hyperliquid 的价格事实。
- Hookdeck Event Gateway：<https://hookdeck.com/>；canonical CLI：<https://github.com/hookdeck/hookdeck-cli>。一手证据只支持入口可靠性，不证明其替 provider 验签。Stream 官方 webhook 合同要求 raw body 与官方 verifier：<https://getstream.io/docs/platform/webhooks/>。Privy 当前 verifier 合同未获 credentialed 证据时继续 default deny。
- Meilisearch：<https://github.com/meilisearch/meilisearch>；dumps：<https://www.meilisearch.com/docs/resources/self_hosting/data_backup/dumps>；security：<https://www.meilisearch.com/docs/capabilities/security/overview>。索引可丢弃重建，不得篡改 provider facts 或升级为 source of truth。
- Chatwoot server v4.17.0：<https://github.com/chatwoot/chatwoot/releases/tag/v4.17.0>；tag-scoped root license：<https://github.com/chatwoot/chatwoot/blob/v4.17.0/LICENSE>；tag-scoped enterprise license：<https://github.com/chatwoot/chatwoot/blob/v4.17.0/enterprise/LICENSE>；OpenAPI：<https://github.com/chatwoot/chatwoot/blob/develop/swagger/swagger.json>。它是 mixed boundary：non-enterprise community code 为 MIT Expat，`enterprise/**` 受独立 Enterprise License，第三方组件许可不被覆盖；只用于 support，不能取代 Stream peer/group/chat/video。
- Chatwoot Flutter component：canonical repo <https://github.com/chatwoot/chatwoot-flutter-sdk>；releases <https://github.com/chatwoot/chatwoot-flutter-sdk/releases>；canonical pub.dev API <https://pub.dev/api/packages/chatwoot_sdk>。仓库无 tag/release，`chatwoot_sdk@0.0.9` archive 与仓库同版本内容漂移，无法闭合不可变 artifact→commit provenance；`chatwoot_flutter_sdk@0.1.1` 指向非 canonical `lordkkjmix` 仓库，不能冒充官方 artifact。该 component 保持 `PENDING_ARTIFACT_SELECTION`，不声称 official/ready Flutter integration。
- Stream Feeds Flutter：<https://github.com/GetStream/stream-feeds-flutter>；package：<https://pub.dev/packages/stream_feeds>；data export：<https://getstream.io/docs/platform/gdpr/>。Flutter closed alpha 与许可/迁移未闭合，所以 relationship/activity 两 gate 必须保持 `PENDING_MUST_REMAIN`。

通知候选必须二选一，Novu/Courier 的 `runtime_selected` 当前为 `null`，禁止长期双运行。Hookdeck 前的 payload 始终不可信：raw bytes/headers 无损到达最薄 provider-specific BFF并完成官方 signature、timestamp/replay 合同校验前，不得 transform 或触发业务 side effect；Hyperliquid WebSocket 不经过 Hookdeck。

## 官方能力来源

- Privy Wallet Actions：<https://docs.privy.io/wallets/actions/overview>；action status：<https://docs.privy.io/wallets/actions/status>；Global Wallet scanning：<https://docs.privy.io/wallets/global-wallets/launch-your-wallet/overview>。最后一项不能证明 LOOP embedded-wallet action 已获得同一 preview，所以 Privy preview 仍需 exact capability audit。
- Stream Chat Flutter：<https://getstream.io/chat/docs/sdk/flutter/>；Stream Video Flutter：<https://getstream.io/video/docs/flutter/>；官方 Legal Center：<https://getstream.io/legal/>。Legal Center 在 2026-08-23 联网复核为 HTTP 200，并明确覆盖 Chat/Video Online Terms；商业、凭据和 credentialed R0 门仍保持 PENDING。Server secret 只能在 BFF 签发短期用户 token，客户端不得持有。
- Hyperliquid API：<https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api>。Info/WebSocket read 与 Exchange/bridge mutation 分离；交易 mutation 必须经过 regional/legal/eligibility gate，未知地区 fail closed。
- Reown AppKit Flutter：<https://docs.reown.com/appkit/flutter/core/installation>。它只承担外部钱包连接边界，不取代 Privy 钱包主权；Community License 与 release provenance 未闭合时保持 PENDING。
- GoPlus：<https://docs.gopluslabs.io/reference/api-overview>。仅展示 token/address/approval/phishing 原始事实和来源，不发明风险分。
- Chainalysis Oracle：<https://go.chainalysis.com/chainalysis-oracle-docs.html>。只作为 sanctions boundary；未证明立即可用的通用 REST 风险合同。
- Blockaid：<https://docs.blockaid.io/>。文档访问受限，endpoint/schema/chain coverage/credential 未闭合。交易 preview 只能用 exact-audited Privy 或 credentialed Blockaid，绝不自建 transaction simulator。
- Alchemy Simulation：<https://www.alchemy.com/docs/reference/simulation-examples>。已是 `deprecated_no_new_integration`，只留审计记录，任何 runtime profile 都不得引用。

## 行情、图表、支付与平台服务

- TradingView Lightweight Charts：<https://tradingview.github.io/lightweight-charts/>。它是 JavaScript renderer，不是 Flutter renderer；必须通过审计后的 WebView bridge 并履行 NOTICE/attribution。在 bridge 完成前 C2、C3 与 Perp chart 均 PENDING。Advanced Charts：<https://www.tradingview.com/advanced-charts/>，还需私有 artifact/license。
- CoinGecko：<https://docs.coingecko.com/reference/introduction>；DEX Screener：<https://docs.dexscreener.com/api/reference>。GeckoTerminal、Birdeye、Nansen 的 SLA、额度和商业条款未闭合时不得以自建 indexer/market-data backend 填补。
- MoonPay hosted widget：<https://moonpay.readme.io/docs/quickstart>。Flutter/WebView、KYB、signed URL、相机、回跳、地区和商店审核未闭合，保持 PENDING。Transak Flutter unsupported/deprecated，不进入 catalog。
- Firebase FCM：<https://firebase.google.com/docs/cloud-messaging/flutter/get-started>；Sentry Flutter：<https://docs.sentry.io/platforms/dart/guides/flutter/>；PostHog Flutter：<https://posthog.com/docs/libraries/flutter>。推送、错误与分析必须分别经过凭据、PII、consent 和 kill-switch gate。

Registry/OSS 的 package name、canonical GitHub identity、runtime-selected pin 与 upgrade-candidate 状态必须从 provider lock 读取；hosted service 也必须用锁中的 official identity/evidence。`archive:<exact-member-path>` locator 只允许 archive 内 exact member，不隐式剥离顶层目录；Hyperliquid Python 的 locator 由 verifier 对 byte-locked upstream sdist 实际解引用并复算 license integrity。README、报告和本页不得成为第二份锁文件。`PENDING` upgrade candidate 不能被 profile 引用，只有对应 slice 完成依赖图、API diff、license、conformance 与 credentialed R0 后，才能显式替换 runtime-selected pin。
