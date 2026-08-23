# LOOP · Flutter 技术栈可行性评估（SDK 层面）

> 调研日期：2026-08-21
> 调研范围：**只核实 Flutter/Dart SDK 真实状况**（能不能接、怎么接、要写多少胶水代码）。不做能力与价格对比。
> 数据来源：pub.dev 官方 API（版本/发布日期/likes/30 日下载量）、GitHub API（stars/最后 push）、各服务官方文档。

---

## 一句话结论

**有条件可行。** Flutter 能做这个产品，但"不写核心代码只做组装"的前提**部分不成立**。

三个关键判断：

1. **嵌入式钱包不是缺口。** Privy 确实有**官方 Flutter SDK**（`privy_flutter`，pub.dev 官方发布，MIT，2026-07-14 更新至 v0.10.1），且支持 `ethSignTypedDataV4`（EIP-712）与 Solana 双链。这是本次调研最重要的正面结论 —— 原先担心的最高优先级风险不存在。**但它仍是 beta（0.x），且 GitHub 仓库 404 不可访问**，出问题只能等官方修。
2. **真正的缺口是 Hyperliquid 与 DApp Browser。** Hyperliquid **没有任何官方 Dart SDK**；社区唯一的 `hyperliquid_dart` 只有 2 stars、30 日下载 33 次、单人维护 —— 按不能用来承载真实资金的标准，等于没有。DApp Browser 依赖的 `flutter_inappwebview` 稳定版停在 **2024-10-08**，EIP-1193 provider 注入必须完全自研。
3. **Chat / RTC / 推送 / 监控这几层是 Flutter 生态的强项**，官方 SDK 齐全且活跃，基本是真"组装"。K 线图表没有 TradingView 官方 Flutter 方案，但有可接受的替代路径。

**结论取向：坚持 Flutter 可行，但必须接受一条架构让步 —— 交易签名与订单执行下沉到自建后端**（详见第六章）。若坚持"Flutter 端全自持私钥直连 Hyperliquid"，工作量与风险都会失控。

---

## 第一章 · SDK 支持总览表

状态分级：
- 🟢 **官方 Flutter/Dart SDK** — 厂商自己发布并维护
- 🟡 **官方但不成熟** — 厂商发布，但 beta / 版本号 0.x / 更新不密
- 🟠 **仅社区包** — 无官方支持，第三方维护
- 🔴 **无 Flutter 支持** — 需 platform channel 桥接原生，或 REST/WS 自封装

### 1.1 嵌入式钱包

| 服务 | 状态 | 包名 | 最新版 / 日期 | likes / dl30 | 结论 |
|---|---|---|---|---|---|
| **Privy** | 🟡 官方 beta | `privy_flutter` | v0.10.1 / 2026-07-14 | 4 / 2,893 | **可用，首选。** 官方 iOS+Android，支持 EVM+Solana、EIP-712、MFA、passkey。但 0.x beta，仓库 404，不支持 Web，不支持私钥导出 |
| **Turnkey** | 🟢 官方 | `turnkey_sdk_flutter` + `turnkey_http` | 均 v2.0.0 / 2026-05~06 | 2 / 320 | 官方 Dart SDK（`tkhq/dart-sdk`），已到 2.0。生态小（4 stars）但是厂商亲自维护，签名基础设施型，适合做后端签名方案的前端配套 |
| **Web3Auth** | 🟢 官方 | `web3auth_flutter` | v7.0.0 / 2026-08-04 | 19 / 617 | 官方维护活跃，已到 v7。成熟度优于 Privy 的版本号信号 |
| **Coinbase (CDP)** | 🟠 陈旧 | `coinbase_wallet_sdk` | v1.0.10 / **2024-09-18** | 26 / 8,306 | **近两年未更新。** 且这是 Wallet 连接 SDK，不是 CDP 嵌入式钱包。CDP 嵌入式钱包未找到官方 Flutter 支持 |
| **Magic** | 🔴 已停滞 | `magic_sdk` | v6.0.1 / **2023-11-27** | 23 / 165 | **近三年未更新，视为废弃** |
| **Dynamic** | 🔴 无 | — | — | — | **未找到官方 Flutter/Dart 包。** 需 WebView 或桥接原生 |
| **Para** | 🔴 无 | — | — | — | 未找到官方 Flutter 支持（待二次确认） |
| **thirdweb** | 🔴 无 | — | — | — | pub.dev 未找到官方包 |
| **Reown / WalletConnect** | 🟢 官方 | `reown_appkit` | v1.8.4 / 2026-08-04 | 19 / 7,856 | 官方（`reown-com/reown_flutter`，2026-08-19 仍在 push）。外部钱包连接用它；`reown_walletkit` v1.4.0 是做钱包端的 |

**关键结论：Privy 有官方 Flutter SDK，最高优先级风险解除。** 备选顺序：Privy → Web3Auth（版本号更成熟）→ Turnkey（配合后端签名架构）。Dynamic / Magic / thirdweb / Para 在 Flutter 上都不可用，不要列入选型。

### 1.2 链交互（Dart 侧）

| 能力 | 状态 | 包名 | 最新版 / 日期 | likes / dl30 | 结论 |
|---|---|---|---|---|---|
| EVM 基础 | 🟠 社区（事实标准） | `web3dart` | v3.0.3 / 2026-06-28 | 526 / 27,797 | Dart 侧 EVM 事实标准，仍在维护（198 stars，87 open issues）。但是社区包，非官方 |
| EVM 多链/签名 | 🟠 社区 | `on_chain` | v8.1.0 / 2026-07-16 | 26 / 1,336 | mrtnetwork 系列，覆盖广、pub 满分，作者单人维护 |
| Solana | 🟠 社区 | `solana` | v0.32.0+1 / 2026-04-10 | 96 / 785 | Espresso Cash 维护（301 stars），仍是 0.x，dl30 仅 785，偏冷 |
| EIP-712 | 🟠 社区，碎片化 | `eip712` v1.0.1 / 2025-12-15（1 like）；`eth_sig_util` v0.0.9 / **2022-07-06** | — | 1~21 / 271~2,346 | **没有权威 EIP-712 Dart 库。** `eth_sig_util` 四年未更新。若走 Privy 的 `ethSignTypedDataV4` 可绕开此坑 |
| **Hyperliquid** | 🔴 **无官方** | `hyperliquid_dart` v0.17.0 / 2026-07-16 | **1 like / dl30=33 / 2 stars** | 详见第二章。官方只有 Python SDK（1,789 stars），TS 社区版（nktkas）活跃，**Dart 无官方** |

### 1.3 Chat / IM

| 服务 | 状态 | 包名 | 最新版 / 日期 | likes / dl30 | 结论 |
|---|---|---|---|---|---|
| **Stream Chat** | 🟢 官方，最活跃 | `stream_chat_flutter` | v10.3.0 / 2026-08-14 | **394 / 41,589** | **Flutter 生态最成熟的 IM。** 264 个版本，官方 UI 组件库齐全。自定义消息类型 + 自定义渲染是一等公民能力 |
| **Sendbird** | 🟢 官方 | `sendbird_chat_sdk` | v4.10.1 / **2026-08-21（当天）** | 17 / 12,129 | 官方维护极勤（当天有发版），65 个版本。UI Kit 另有包 |
| **Agora Chat** | 🟢 官方 | `agora_chat_sdk` | v1.4.0 / 2026-07-02 | 33 / 4,196 | 官方，活跃 |
| **PubNub** | 🟢 官方 | `pubnub` | v8.0.2 / 2026-08-11 | 52 / 10,941 | 官方 Dart SDK，活跃。但它是消息基础设施，IM 语义（会话/群/未读）要自己搭 |
| **CometChat** | 🟢 官方 | `cometchat_sdk` + `cometchat_chat_uikit` | v5.0.6 / v6.1.0，均 2026-07-24 | 11~14 / 1,796~2,659 | 官方 SDK + 官方 UI Kit 双包齐全 |
| **腾讯云 IM** | 🟢 官方 | `tencent_cloud_chat_sdk` | v9.0.7652+1 / 2026-06-08 | 34 / 4,162 | 官方，国内方案里数据最好 |
| **融云** | 🟢 官方 | `rongcloud_im_wrapper_plugin` | v5.44.0 / 2026-08-18 | 7 / 1,396 | 官方 wrapper，维护活跃 |
| **网易云信** | 🟢 官方 | `nim_core` | v1.9.0+3 / 2026-01-23 | 8 / 435 | 官方（`netease-kit/NIM-Flutter-SDK`），更新偏慢 |
| 环信 | 🟢 官方 | 同 Agora Chat（`agora_chat_sdk`，环信是 Agora Chat 的国内品牌） | v1.4.0 / 2026-07-02 | 33 / 4,196 | 见上 |

### 1.4 语音 RTC

| 服务 | 状态 | 包名 | 最新版 / 日期 | likes / dl30 | 结论 |
|---|---|---|---|---|---|
| **Agora RTC** | 🟢 官方，最强 | `agora_rtc_engine` | v6.6.3 / 2026-04-14 | **878 / 48,420** | 135 个版本，官方维护。Flutter 语音房首选 |
| **LiveKit** | 🟢 官方，下载量最高 | `livekit_client` | v2.11.0 / 2026-08-11 | 268 / **157,441** | 官方（`livekit/client-sdk-flutter`），dl30 是 Agora 的 3 倍，更新更勤。开源可自托管 |
| **100ms** | 🟢 官方 | `hmssdk_flutter` | v1.11.1 / 2026-04-13 | 139 / 3,044 | 官方，活跃度尚可 |
| **Zego** | 🟢 官方 | `zego_uikit_prebuilt_call` 等 | 待补 | — | 官方有 prebuilt UI 系列包 |

**结论：语音房这一层是纯组装，无风险。** Agora 或 LiveKit 二选一。

### 1.5 K 线图表

| 方案 | 状态 | 包名 | 最新版 / 日期 | likes / dl30 | 结论 |
|---|---|---|---|---|---|
| **TradingView** | 🔴 **无官方 Flutter** | — | — | — | 只能 WebView 内嵌 Charting Library。pub.dev 上 `trading_view_flutter`(6 likes) 等均为个人套壳，不可用于生产 |
| `k_chart` | 🟠 社区，**已停滞** | `k_chart` | v0.7.1 / **2023-05-30** | 174 / 370 | **三年未更新**（repo 2023-09 最后 push）。虽是中文圈知名交易所 K 线包，但已不能直接用 |
| `k_chart_plus` | 🟠 社区 fork | `k_chart_plus` | v1.0.4 / 2025-12-21 | 20 / 432 | k_chart 的维护 fork，稍新但生态小（仅 5 个版本） |
| **`deriv_chart`** | 🟡 **厂商开源** | `deriv_chart` | v0.5.0 / 2026-01-29 | 27 / 330 | **Deriv（真实券商）生产用图表**，repo 2026-08-17 仍在 push。pub 分数低（50）因文档/规范，但工程质量是生产级 |
| `candlesticks` | 🟠 社区 | `candlesticks` | v3.0.1 / 2026-05-22 | 140 / 947 | 轻量，指标能力有限 |
| `syncfusion_flutter_charts` | 🟢 商业官方 | 同名 | v34.2.4 / 2026-08-18 | 3,639 / 202,440 | 商业授权，官方维护极勤（383 个版本）。有蜡烛图+技术指标，但非交易所级交互 |
| `fl_chart` | 🟠 社区，最流行 | `fl_chart` | v1.2.0 / 2026-03-13 | **7,184 / 1,680,391** | 通用图表王者，**但不是交易级 K 线**（无多周期/指标体系/专业手势） |
| `interactive_chart` | 🟠 社区 | `interactive_chart` | v0.3.6 / 2025-06-09 | 181 / 1,375 | 轻量蜡烛图带缩放 |
| `graphic` | 🟠 社区 | `graphic` | v2.7.0 / 2026-02-25 | 895 / 45,314 | 语法驱动图表，非专用 K 线 |

详见第三章推荐。

### 1.6 其他配套

| 能力 | 状态 | 包名 | 最新版 / 日期 | likes / dl30 | 结论 |
|---|---|---|---|---|---|
| 推送 | 🟢 官方 | `firebase_messaging` | v16.5.0 / 2026-08-03 | 3,943 / 2,858,697 | 零风险 |
| 崩溃监控 | 🟢 官方 | `sentry_flutter` | v9.27.0 / 2026-08-13 | 1,083 / 1,430,320 | 零风险 |
| 产品分析 | 🟢 官方 | `posthog_flutter` | v5.36.6 / 2026-08-20 | 91 / 308,865 | 零风险，官方维护极勤 |
| **DApp Browser** | 🟠 社区，**稳定版陈旧** | `flutter_inappwebview` | 稳定 v6.1.5 / **2024-10-08**；beta v6.2.0-beta.3 / 2026-02-04 | 2,845 / **1,158,927** | **重点风险，见第二章。** 唯一可选，无替代 |
| 法币出入金 | 🔴 无官方 Flutter | — | — | — | MoonPay / Transak 均**未找到官方 Flutter SDK**，只能 WebView 内嵌其 widget（业界通行做法，可接受） |

---

## 第二章 · 高风险缺口详解

### 2.1 Privy —— 风险已大幅降低，但仍是 beta

**核实结果：有官方 Flutter SDK。**

- pub.dev 包名：`privy_flutter`，v0.10.1，2026-07-14 发布，MIT，pub 分数 160/160
- 官方文档明确列 Flutter：`docs.privy.io/basics/flutter/`（installation / quickstart / features / changelog 四套齐全）
- 版本节奏健康：0.4.0(2025-09) → 0.10.1(2026-07)，10 个月 8 个大版本
- 平台：iOS 16/17+ 与 Android API 27+。**Web 不支持**（LOOP 只做 iOS+Android，不影响）
- 环境硬要求：Flutter 3.24+、Xcode 16+、Kotlin 2.1.0+、**必须启用 Swift Package Manager**（`flutter config --enable-ios-swift-package-manager`）—— 这条会影响 CI 与其他 iOS 插件兼容性，需要提前验证

**能力覆盖（对 LOOP 关键的部分）：**

| 能力 | 支持 |
|---|---|
| 邮箱 / 短信 OTP、passkey、OAuth（Google/Apple/Twitter/Discord/Telegram） | ✅ |
| 自定义 Auth / JWT | ✅ |
| EVM 嵌入式钱包 | ✅ |
| **Solana 嵌入式钱包** | ✅（含多钱包、`signTransaction`、`signAndSendTransaction`） |
| **`ethSignTypedDataV4`（EIP-712）** | ✅ **—— 这是 Hyperliquid 下单的前提，已具备** |
| `personalSign` / `ethSign` / `secp256k1Sign` / `ethSignTransaction` / `ethSendTransaction` | ✅ |
| MFA（SMS / TOTP / passkey） | ✅（0.9.0 起） |
| `generateAuthorizationSignature` | ✅ |
| **私钥导出** | ❌ **不支持** —— 产品若承诺"资产可自主导出"会与此冲突，需产品侧确认 |

**残留风险（必须记入项目风险台账）：**

1. **官方标注 beta，接口可能变更。** 0.x 版本意味着 breaking change 是被允许的。10 个月 8 个版本的节奏，升级维护成本要预留。
2. **GitHub 仓库 `privy-io/flutter-sdk` 返回 404。** pub.dev 的包分析页面也标注"Repository URL doesn't exist"。虽然 license 是 MIT，但**源码实际不可访问** —— 这意味着：遇到 bug 无法自己读源码定位、无法提 PR、无法 fork 自救，只能开工单等官方。对一个要承载真实资金的钱包，这是实质性的供应商锁定风险。
3. **`ethSignTypedDataV4` 能否签 Hyperliquid 的 chainId 1337 域，未经实测确认。** Hyperliquid L1 action 使用 `chainId: 1337` + `name: "Exchange"` 的非常规 EIP-712 域。部分钱包 SDK 会校验 chainId 是否在已配置链列表内并拒签。**这是必须在选型阶段做 PoC 验证的第一件事**（见第七章）。

**替代路径工作量（若 Privy 最终不可用）：**

| 路径 | 工作量 | 风险 |
|---|---|---|
| 改用 `web3auth_flutter`（v7.0.0，官方，版本号更成熟） | 5~8 人日迁移 | 低。**推荐作为 Plan B** |
| 改用 Turnkey（`turnkey_sdk_flutter` v2.0.0 官方 Dart SDK） | 8~12 人日 | 中。生态最小（4 stars）但厂商亲自维护，且天然适配"后端签名"架构 |
| WebView 内嵌 Privy JS SDK | 15~20 人日 | **高。不推荐。** 私钥材料在 WebView 里、Dart↔JS 双向桥、生命周期与登录态同步、iOS WebView 存储被清理导致掉登录，全是坑 |
| platform channel 桥接 Privy 原生 iOS/Android SDK | 20~30 人日 | **高。不推荐。** 等于自己重写一遍官方已经做好的 Flutter SDK，且双端各写一次 |

### 2.2 Hyperliquid —— 最大的真实缺口

**核实结果：没有任何官方 Dart / Flutter SDK。**

官方 SDK 只有 **Python**（`hyperliquid-dex/hyperliquid-python-sdk`，1,789 stars，563 forks，2026-06-04 仍在 push）。TypeScript 有活跃社区版（`nktkas/hyperliquid`），Rust 有社区版（`hypersdk`，README 明确声明"非官方"）。

**Dart 侧现状：**

- `hyperliquid_dart` v0.17.0（2026-07-16），自称支持 REST + WebSocket + EIP-712 签名 + 订单管理
- **但：1 like、30 日下载 33 次、GitHub 仅 2 stars / 0 forks / 0 issues、只有 5 个发布版本、单人仓库（`Riten-Zone`）**
- **判断：不可用于承载真实资金。** 一个下载量 33 次的包意味着几乎没有人在生产环境验证过它的签名正确性。签名错一位，用户的单就废了或者下错方向。这类包可以读来学习 wire format，不能直接依赖。

**为什么 Hyperliquid 特别难：** 它不是普通 REST 签名，而是一套双域 EIP-712 体系：

| 类型 | chainId | EIP-712 domain name | 用途 |
|---|---|---|---|
| L1 Action | `1337` | `Exchange` | 下单 / 撤单 / 改单 / 调杠杆 / 子账户划转 |
| User-Signed Action | `0x66eee`(421614) | `HyperliquidSignTransaction` | USD/现货划转、提现、授权 agent、builder fee |

L1 action 走 **"phantom agent"** 构造：action 先用 **MessagePack** 序列化 → 拼 nonce/vaultAddress/expiresAfter → **Keccak-256** 哈希 → 再作为 EIP-712 typed data 签名。同时订单要转 wire format（`asset→a`、`is_buy→b`、`limit_px→p`、`sz→s`、`reduce_only→r`、`order_type→t`、`cloid→c`）。

**Dart 侧自建的具体障碍：**

1. **MessagePack 序列化必须与官方 Python 实现逐字节一致** —— 字段顺序、整数编码宽度、浮点/字符串表示，任何差异都会导致 action hash 不同 → 签名校验失败。这是最容易踩且最难调试的地方（服务端只会回一个笼统的签名错误）。
2. **数值精度。** 价格/数量在 Hyperliquid 有 tick size 与 significant figures 规则，Dart 的 `double` 与 Python `Decimal` 行为不同，序列化成字符串时容易多/少一位。
3. **Dart 没有权威 EIP-712 库。** `eth_sig_util` 停在 2022-07（四年未更新），`eip712` 只有 1 like。若用 Privy 的 `ethSignTypedDataV4` 可以把签名这一步交给 SDK，但**构造 typed data 结构体和算 action hash 这部分仍需自己写**。
4. **无参考实现可对照。** 出问题时你没法说"我照着官方 Dart SDK 写的"，只能拿 Python SDK 逐步骤比对中间产物（msgpack 字节、keccak 结果、最终签名）。

**两条路的工作量对比：**

| 方案 | 工作量 | 说明 |
|---|---|---|
| **A. Dart 侧自研全套** | **15~25 人日**（含与 Python SDK 逐字节对照调试） | 下单/撤单/改单/杠杆/持仓/资金划转 + WS 行情与账户推送 + msgpack/keccak/EIP-712 + 精度处理。**风险最高，且这块 bug 直接等于用户资金损失** |
| **B. 后端封装（推荐）** | **后端 8~12 人日 + Flutter 端 3~5 人日** | 后端直接用**官方 Python SDK**（1,789 stars，久经验证），暴露自有 REST/WS 给 App。Flutter 只做 UI + 调自家接口。**签名正确性由官方 SDK 保证，这是最大的价值** |

**方案 B 会改架构，必须现在就定：** 签名放后端意味着后端要持有下单权限。Hyperliquid 的 **agent wallet / API wallet** 机制正好为此设计 —— 用户用主钱包（Privy 嵌入式钱包，Dart 侧只签这一次 `approveAgent`）授权一个后端持有的 agent wallet，agent 只能交易、**不能提现**。这样后端被攻破的最坏情况是乱交易，而不是资产被卷走。这是业界（包括多家 Hyperliquid 前端）的通行做法，也是本报告的核心架构建议。

### 2.3 DApp Browser —— 可行，但底座维护状态需要盯

**核实结果：`flutter_inappwebview` 是唯一选择，且有现成的 EIP-1193 注入方案。**

**底座风险：**
- `flutter_inappwebview` **稳定版停在 v6.1.5 / 2024-10-08，已近两年**
- 后续只有 beta：`6.2.0-beta.1`(2024-11) → `beta.2`(2024-11) → **`beta.3`(2026-02-04)** —— 14 个月才出一个 beta，节奏明显放缓
- 但生态无可替代：2,845 likes、**30 日下载 115 万次**、3,758 stars、repo 2026-02-10 仍有 push
- **判断：能用，但要预算"自己修 WebView 层 bug"的成本**，尤其 iOS 新版本发布后的适配。官方 `webview_flutter` 功能太弱（不支持 `addUserScript` 之类的早期注入能力），做不了 DApp Browser

**EIP-1193 注入：不必从零写。**

| 包 | 版本 / 日期 | 维护方 | 评价 |
|---|---|---|---|
| **`flutter_web3_webview`** | v1.0.0 / 2026-06-10，7 likes，dl30=107 | **FX Wallet 官方**（`fxwalletOfficial/fx-wallet-packages`） | **最佳起点。** 真实钱包厂商开源自用代码。在页面脚本执行前注入 `window.ethereum`（EIP-1193 + **EIP-6963**）与 Solana wallet-standard provider；覆盖 `eth_requestAccounts`/`eth_accounts`/`eth_chainId`/`personal_sign`/`eth_signTypedData` v3/v4/`eth_sendTransaction`/`wallet_switchEthereumChain`/`wallet_addEthereumChain`；支持回推 `chainChanged`/`accountsChanged`；可选 MetaMask 伪装（`isMetaMask`）；是 `InAppWebView` 的超集，转发全部回调 |
| `web3_provider` | v1.1.4 / **2023-06-20** | Position Exchange | 三年未更新，`InAppWebViewEIP1193` 组件。可参考，不建议直接依赖 |
| `flutter_injected_web3` | v1.0.1 / **2022-11-15** | Orange Wallet | 四年未更新，基于改造过的 Trust Wallet provider。已过时 |

**关键技术点（踩坑预警）：** provider 必须在**页面脚本执行前**注入。在 `onPageFinished` 注入已经太晚，DApp 拿不到 `window.ethereum`（StackOverflow 有明确案例）。必须用 `addUserScript` + `UserScriptInjectionTime.AT_DOCUMENT_START`。`flutter_web3_webview` 已按此设计，这也是不要自己从零写的主要理由。

**LOOP 需要自研的部分（`flutter_web3_webview` 不提供）：**

1. **无限授权拦截** —— 需要解析 `eth_sendTransaction` 的 calldata，识别 `approve(address,uint256)` 且 amount 为 `2^256-1`（或超大值）、以及 `setApprovalForAll(address,bool)`，弹出风险提示并允许用户改成有限额度。要维护一份 spender 黑白名单。
2. **交易模拟与风险提示 UI**（AI 安全层的落点）。
3. **多链切换与 RPC 管理**、书签/历史/搜索等浏览器外壳。
4. **签名请求的统一确认弹窗**（与 Privy 钱包打通）。

合计 **10~15 人日**，其中无限授权拦截 + 交易解析约占一半。这部分是 LOOP 的产品差异化，本来也不该外购。

---

## 第三章 · K 线图表方案推荐

### 3.1 TradingView 的真实情况

**没有官方 Flutter 方案。** TradingView 官方只提供 Charting Library（JS）与 Advanced Charts，移动端官方支持是 iOS/Android 原生封装与 Web。pub.dev 上的 `trading_view_flutter`(6 likes)、`trading_chart_flutter`(3 likes)、`tradingview_ta`(2023 年，做技术指标抓取的，不是图表) 全是个人套壳项目，**不可用于生产**。

**WebView 内嵌 Charting Library 的代价：**

- 优点：功能最全（几十种指标、画线工具、多周期、用户习惯的完整交互），产品体验天花板最高
- 代价：
  1. **性能与内存** —— 合约页面本就有 WebSocket 高频推送，WebView 里跑图表会明显吃内存；低端 Android 机型上滚动与图表手势会互相抢，掉帧可感知
  2. **交互割裂** —— 图表在 WebView 里，Flutter 的手势竞技场（gesture arena）与 WebView 的触摸处理冲突，图表缩放/拖拽和外层页面滚动的边界很难调顺，这是内嵌方案最常被用户吐槽的点
  3. **数据桥开销** —— 实时行情要从 Dart 侧 WS 通过 JS bridge 灌进图表，高频下 bridge 成为瓶颈，通常要做批量/节流
  4. **Charting Library 需要申请授权**（非公开 npm 包，要向 TradingView 申请，有商业条款）
  5. 冷启动白屏、字体/主题与 App 不一致、深色模式切换要额外做

### 3.2 Dart 原生候选评估

| 包 | 交易级能力 | 维护状态 | 结论 |
|---|---|---|---|
| **`deriv_chart`** | ✅ 多周期、技术指标、缩放拖拽、十字光标、实时 tick 追加 | v0.5.0 / 2026-01-29，repo **2026-08-17 仍在 push**，Deriv 官方 | **推荐首选。** 真实券商（Deriv）生产在用的图表引擎，为高频 tick 与专业交互设计。生态数字不好看（27 likes / dl30=330 / 52 stars）是因为它是"公司自用开源"而非社区项目，**工程质量与 likes 不成正比** |
| `k_chart` | ✅ 交易所风格完整（MA/BOLL/MACD/KDJ/RSI/WR + 分时/K线切换） | **v0.7.1 / 2023-05-30，repo 2023-09 最后 push，三年停滞** | **不能直接用。** 但它 519 stars / 258 forks，是中文圈最贴近"交易所 K 线"的实现。**可行路径：fork 自维护**，或用 `k_chart_plus`(v1.0.4 / 2025-12) 这个维护 fork 起步 |
| `syncfusion_flutter_charts` | ⚠️ 有蜡烛图与技术指标，但定位是通用商业图表 | v34.2.4 / 2026-08-18，官方极勤（383 个版本） | **稳妥但不够专业。** 商业授权（有免费社区许可条件）。做 Home/Market 的迷你走势图很好，做合约主图交互精细度不够 |
| `candlesticks` | ⚠️ 轻量，指标能力有限 | v3.0.1 / 2026-05-22，140 likes | 适合简单场景，撑不住合约页 |
| `interactive_chart` | ⚠️ 蜡烛+缩放，功能基础 | v0.3.6 / 2025-06-09，181 likes | 同上 |
| `fl_chart` | ❌ **不是交易级 K 线** | v1.2.0 / 2026-03-13，**7,184 likes / dl30 168 万** | Flutter 图表王者，但没有多周期/指标体系/专业手势。**用它做 Home 页资产曲线、Token 卡片缩略走势，不要用它做合约主图** |
| `graphic` | ❌ 语法驱动通用图表 | v2.7.0 / 2026-02-25，895 likes | 同上，非专用 |

### 3.3 明确推荐

**分层用图，不要一套打天下：**

| 场景 | 方案 |
|---|---|
| Home 页资产曲线、Token 卡片缩略走势、Launchpad 简单图 | **`fl_chart`** —— 生态最稳，零风险，开发最快 |
| **Market 现货/合约主图（多周期、指标、缩放拖拽、实时推送）** | **`deriv_chart` 为主，`k_chart`/`k_chart_plus` fork 为备** |
| 若产品要求"必须和主流交易所体验完全一致、指标画线全套" | 才考虑 WebView + TradingView Charting Library，并接受第 3.1 节全部代价 |

**理由：** 交易级 K 线在 Flutter 里"最省事"的做法不是找一个完美的包（不存在），而是**选一个工程质量够、还在维护、能读懂源码去改的 Dart 原生包**。`deriv_chart` 满足这三点，且纯 Dart 渲染没有 WebView 的手势冲突与内存问题 —— 而手势冲突恰恰是交易 App 里最伤体验的问题。

预估工作量：**10~15 人日**（接入 + 实时 WS 数据管道 + 指标配置 UI + 主题适配 + 多周期切换）。若走 WebView + TradingView：**15~22 人日**，且后续性能调优是长期成本。

---

## 第四章 · 必须自研的胶水代码清单

"不写核心代码只做组装"在以下条目上不成立 —— 这些是**买不到、必须自己写**的。人日按 1 个熟练 Flutter 工程师计，不含产品设计与 UI 视觉还原。

### 4.1 高风险 / 必做

| # | 项目 | 人日 | 说明 |
|---|---|---|---|
| 1 | **Hyperliquid 交易层（后端封装方案）** | **后端 8~12 + Flutter 3~5** | 后端用官方 Python SDK 包一层自有 REST/WS；Flutter 只调自家接口。**强烈建议走这条** |
| 1b | *（备选）Hyperliquid Dart 侧自研* | *15~25* | msgpack 逐字节对齐 + keccak + EIP-712 双域 + wire format + 精度处理 + WS。**风险最高，不推荐** |
| 2 | **DApp Browser 外壳与安全层** | **10~15** | 基于 `flutter_web3_webview` 扩展：无限授权拦截（解析 `approve`/`setApprovalForAll` calldata）、交易解码与风险提示、多链切换、书签/历史、统一签名确认弹窗 |
| 3 | **Privy 钱包适配层** | **5~8** | 把 `privy_flutter` 的 EIP-1193 风格 provider 包成 App 内统一钱包接口，供 Swap / 合约 / DApp Browser / 签名弹窗共用；登录态与 App 路由/持久化打通；MFA 与错误态处理 |
| 4 | **K 线图表接入与实时数据管道** | **10~15** | `deriv_chart` 接入 + WS 增量 tick 合并到蜡烛 + 多周期切换 + 指标配置 UI + 主题适配 + 断线重连补数据 |
| 5 | **多链 Swap / 跨链聚合器接入** | **8~12** | 聚合器（如 LI.FI/0x/Jupiter 等）均只有 REST，**无 Dart SDK**，需自封装：报价轮询、路由展示、滑点/授权流程、跨链状态追踪与轮询回执 |
| 6 | **行情数据层** | **6~10** | 现货+合约行情、K 线历史、深度、资金费率等，来源多为 REST/WS，Dart 侧统一封装 + 缓存 + 断线重连 + 限流 |

### 4.2 中等风险

| # | 项目 | 人日 | 说明 |
|---|---|---|---|
| 7 | **Token 卡片消息（自定义消息类型 + 渲染）** | **4~6** | Stream Chat 支持自定义 attachment builder（v10 走 `StreamChatConfigurationData.attachmentBuilders` + `StreamAttachmentWidgetBuilder`，并需 `FallbackAttachmentBuilder` 兜底）。能力是现成的，但**注意 v7→v10 该 API 改过两次**（`customAttachmentBuilders` 已废弃），升级要重写这层 |
| 8 | **语音房音频会话治理** | **5~8** | 见 4.3 已知坑。iOS `AVAudioSession` category/mode 管理、来电中断恢复、后台模式、与 App 内其他音频（视频播放）互斥 |
| 9 | **法币出入金 WebView 封装** | **3~5** | MoonPay/Transak 均无官方 Flutter SDK，只能内嵌其 widget。**注意 Transak 官方明确声明不支持 Flutter**（见 4.4），需处理 KYC 相机权限、回跳、订单状态回查 |
| 10 | **EVM 交易构造与 Gas 策略** | **5~8** | `web3dart` 只给基础能力，nonce 管理、EIP-1559 费率估算、失败重试、加速/取消、多链 gas 差异都要自己写 |
| 11 | **Solana 交易构造** | **4~6** | `solana` 包仍 0.x 且 dl30 仅 785，priority fee、ALT、SPL token account 创建等要自己补 |
| 12 | **AI 安全层前端接入** | **3~5** | 假设 AI 判定在后端；Flutter 侧做风险分展示、拦截弹窗、用户覆盖决策与埋点 |

### 4.3 语音 RTC 的已知坑（实测确认有 issue 记录）

Flutter 上 RTC 的音频会话问题是真实存在且反复出现的，必须预留调试时间：

- **LiveKit**：CallKit 场景下扬声器无法从系统 UI 关闭（issue #725，2.3.6 仍有人复现）；`setSpeakerPhoneOn(true)` 后状态可能卡死。需在 iOS AppDelegate 手动接管：`useManualAudio = true` + `isAudioEnabled = false`，再在 `audioSessionDidActivate/Deactivate` 里开关。相关修复依赖 `flutter_webrtc` 0.12.5+hotfix.2（iOS 音频路由）
- **LiveKit**：iOS 18 扬声器模式下回声消除失效，agent 被自己的声音触发 VAD（issue #689）
- **Agora**：加入频道后 App 内其他音频（如播放 mp3）音量递减至静音，日志报 `Deactivating an audio session that has running I/O`（issue #899）
- **共性**：iOS 后台音频必须配置 background modes；`AVAudioSession` 的 category/mode 组合（`playAndRecord` + `voiceChat`/`videoChat`）、`allowBluetooth`/`defaultToSpeaker`/`mixWithOthers` 选项要按场景精调；来电中断后的恢复要自己处理

**结论：RTC SDK 本身是"组装"，但音频会话治理是"必须自研"，别按零成本估。**

### 4.4 Flutter 特有的硬约束（选型必须知道）

1. **Transak 官方声明不支持 Flutter。** 其文档页标题为 "Flutter (Deprecated)"，明确只支持 Android / iOS / React Native，理由是 Flutter 的 WebView 与插件架构不同，**KYC 相机/媒体权限与会话/回跳行为无法被其验证保证**。这不是"能不能塞进 WebView"的问题，而是出问题厂商不背书。**若法币入金是核心路径，这一条直接影响厂商选型**（需换 MoonPay 或其他愿意支持的通道，或接受无官方支持）。
2. **Privy 要求 iOS 走 Swift Package Manager**。需 `flutter config --enable-ios-swift-package-manager`。SPM 与传统 CocoaPods 插件混用在部分插件上仍有兼容问题，且 CI 构建脚本要改。**开工第一周就要验证：Privy + Agora/LiveKit + flutter_inappwebview 三者能否在同一个 iOS 工程里共存编译。** 这是本项目最可能拖工期的隐蔽风险。
3. **`flutter_inappwebview` 稳定版近两年未更新**，iOS 大版本升级后的适配可能要自己打补丁或用 beta 版。
4. **Privy 不支持私钥导出**，与"用户资产完全自主"的产品叙事冲突，需产品侧决策。

### 4.5 工作量汇总

| 分类 | 人日区间 |
|---|---|
| 高风险必做（1~6，Hyperliquid 走后端方案） | **50~77**（其中后端 8~12） |
| 中等风险（7~12） | **24~38** |
| **合计（纯胶水/自研部分）** | **74~115 人日** |

**注意：这只是"胶水与自研"，不含六个 Tab 的全部业务 UI、设计还原、状态管理、国际化、测试、上架合规。** 完整产品的总量会显著高于此数。所谓"只做组装"，实际组装成本约 **3.5~5.5 人月**（单人）。

---

## 第五章 · Flutter vs React Native vs 原生 取舍

| 维度 | Flutter | React Native | 原生双端 | Flutter + WebView 混合 |
|---|---|---|---|---|
| **嵌入式钱包（Privy）** | 🟡 官方 beta SDK（0.x，仓库不可访问） | 🟢 官方 SDK 成熟（`@privy-io/expo`/RN，与 Web 同源，功能最全，含私钥导出等） | 🟢 官方 iOS/Android SDK 成熟 | 🟡 同 Flutter |
| **Hyperliquid** | 🔴 无官方 Dart SDK | 🟢 可直接用成熟 TS 生态（`nktkas/hyperliquid` 等），与官方文档示例一致 | 🔴 Swift/Kotlin 也无官方 SDK，同样要自写 | 🟡 可在 WebView 里跑 TS SDK，但架构别扭 |
| **EVM / Solana 库** | 🟠 社区包（web3dart / solana，皆非官方） | 🟢 **viem/ethers/wagmi + @solana/web3.js，web3 生态原产地** | 🟠 各链官方移动库参差 | 🟢 WebView 内可用 JS 生态 |
| **DApp Browser** | 🟡 需自研 provider 注入（有 `flutter_web3_webview` 打底） | 🟢 生态成熟，参考实现多（MetaMask Mobile 等均 RN） | 🟢 WKWebView/Android WebView 直接控制，最灵活 | 🟡 同 Flutter |
| **法币出入金** | 🔴 Transak 明确不支持 Flutter | 🟢 **Transak/MoonPay 官方支持 RN** | 🟢 官方支持 | 🔴 同 Flutter |
| **K 线图表** | 🟡 无 TradingView 官方方案，`deriv_chart` 可用 | 🟢 TradingView Charting Library 在 RN WebView 里是业界标配路径 | 🟢 TradingView 有原生封装方案 | 🟢 内嵌 TradingView 最顺 |
| **IM / RTC** | 🟢 官方 SDK 齐全（Stream/Sendbird/腾讯/融云；Agora/LiveKit/100ms/Zego） | 🟢 齐全 | 🟢 最全 | 🟢 齐全 |
| **UI 一致性与动画** | 🟢 **最强**，双端像素一致，自绘引擎，复杂动效成本最低 | 🟡 依赖原生组件，双端有差异，复杂动效需 Reanimated 调优 | 🔴 两套 UI，成本翻倍 | 🟢 除 WebView 部分 |
| **开发效率（六 Tab 大型 App）** | 🟢 高 | 🟢 高 | 🔴 低（≈1.7~2x） | 🟡 中 |
| **性能（长列表/高频行情）** | 🟢 好 | 🟡 桥/JSI 有开销，高频推送需优化 | 🟢 最好 | 🟡 WebView 部分是短板 |
| **招人难度** | 🟡 中 | 🟢 易（web 前端可转） | 🔴 难（要 iOS+Android 两个人） | 🟡 中 |
| **web3 人才可复用性** | 🔴 差（Dart 侧 web3 经验的人极少） | 🟢 **最好**（web3 开发者基本都会 TS） | 🟡 中 |

### 诚实结论

**如果此刻还没拍板，React Native 是这个特定产品（web3 超级应用 + Hyperliquid + DApp Browser + 法币入金）更省事的选择。** 理由不是 RN 更好，而是**web3 的 SDK 生态原产地是 TypeScript**：Privy 的 RN SDK 功能最全、Hyperliquid 有成熟 TS 库、Transak/MoonPay 官方支持 RN、TradingView 内嵌是 RN 圈的标准做法。选 RN 能把第四章 74~115 人日的自研量压掉相当一部分（保守估计减少 20~35 人日，主要来自 Hyperliquid 与法币通道）。

**但"已拍板 Flutter"不构成推翻决策的理由级缺口。** 因为：

1. 最担心的 Privy **确实有官方 Flutter SDK 且支持 EIP-712**，最高优先级风险已解除
2. Hyperliquid 的缺口可以用"后端封装官方 Python SDK"完全绕开，而且**这个方案在任何技术栈下都是更安全的做法**（签名逻辑集中、可审计、可热修，不用发版）
3. IM / RTC / 推送 / 监控这些占代码量最大的部分，Flutter 官方 SDK 齐全
4. Flutter 在六 Tab 大型 App 的 UI 一致性与动效成本上明显优于 RN，对一个要做品牌感的 C 端产品是实打实的收益

**不推荐原生双端**：这个产品功能面太宽（六 Tab + 交易 + IM + 语音 + 浏览器），两套 UI 的成本换不来对应收益，除非团队本来就有 iOS/Android 双端人力。

**不推荐"Flutter + WebView 混合"作为主架构**：把交易或钱包放 WebView 会同时承担 Flutter 的生态短板和 WebView 的性能/体验短板，只在 TradingView 图表与法币入金这两个**局部**用 WebView 是合理的。

**最终建议：坚持 Flutter，但必须接受第六章的架构让步。** 如果团队愿意重新讨论技术栈，且 web3 经验主要在 TS 侧，那么 RN 值得再评估一轮 —— 这个决定的成本差主要落在 Hyperliquid 与法币入金两处。

---

## 第六章 · 推荐架构（最小风险方案）

核心原则：**把 Dart 生态薄弱的部分（密码学、交易签名、聚合路由）移出 Flutter，Flutter 只做 UI + 调自家后端 + 官方 SDK 组装。**

### 6.1 分层

**Flutter 端（只做三件事）**
1. UI 与状态管理（六 Tab 全部界面）
2. 官方 SDK 组装：`privy_flutter`（登录+钱包+签名）、`stream_chat_flutter`（IM）、`agora_rtc_engine` 或 `livekit_client`（语音房）、`firebase_messaging` / `sentry_flutter` / `posthog_flutter`
3. 调用自建后端的 REST/WS，不在 Dart 侧实现任何交易协议

**自建后端（BFF，承担所有协议复杂度）**
1. **Hyperliquid 网关** —— 用官方 Python SDK（1,789 stars）实现下单/撤单/改单/杠杆/持仓/划转；对 App 暴露简单 REST + WS。**签名正确性由官方 SDK 保证，这是本架构最大的价值**
2. **Swap / 跨链聚合** —— 后端对接聚合器 REST，返回可直接签名的 calldata 给 App，App 用 Privy 签名后广播（或后端广播）
3. **行情聚合** —— 统一 K 线/深度/资金费率，做缓存与限流，App 只连自家 WS（同时避免把第三方 API key 放进客户端）
4. **AI 安全层** —— 交易/授权风险判定在后端，App 只展示与拦截

### 6.2 密钥与权限模型（关键设计）

- **用户主钱包 = Privy 嵌入式钱包，私钥永远不出 Privy 的安全边界，后端永不接触**
- **Hyperliquid 交易走 agent wallet（API wallet）**：用户在 App 内用 Privy 签**一次** `approveAgent`（这是 user-signed action，`chainId 0x66eee`，走 `ethSignTypedDataV4`），授权后端持有的 agent wallet
  - agent wallet **只能交易，不能提现** —— 后端被攻破的最坏情况是乱下单，而非资产被卷走
  - 这是 Hyperliquid 官方为此设计的机制，也是多家 Hyperliquid 前端的通行做法
- **提现 / 转账 / 授权等资金移动类操作，一律回到 App 内用 Privy 签名**，后端只做广播和状态追踪
- **DApp Browser 的签名请求**全部走 App 内 Privy 弹窗确认，WebView 拿不到任何私钥材料

### 6.3 具体选型建议

| 层 | 选择 | 理由 |
|---|---|---|
| 嵌入式钱包 | **`privy_flutter`**，Plan B 为 `web3auth_flutter` | 官方 Flutter + EIP-712 + Solana。Plan B 版本号更成熟 |
| 外部钱包连接 | `reown_appkit` v1.8.4 | 官方且活跃 |
| Hyperliquid | **后端官方 Python SDK 封装** | 唯一能保证签名正确性的路径 |
| EVM 基础 | `web3dart` v3.0.3 | Dart 事实标准（仅用于读链与轻量构造，重活在后端） |
| Solana | `solana` v0.32.0+1 | 唯一可选，注意仍 0.x |
| IM | **`stream_chat_flutter`** v10.3.0 | Flutter 生态最成熟（394 likes / dl30 41.6k / 264 版本），自定义消息渲染是一等公民，Token 卡片消息刚好命中。国内合规需求则用 `tencent_cloud_chat_sdk` |
| 语音房 | **`agora_rtc_engine`** v6.6.3 或 `livekit_client` v2.11.0 | 前者 878 likes 生态最厚；后者 dl30 15.7 万、更新更勤、可自托管。**预留 5~8 人日做音频会话治理** |
| K 线主图 | **`deriv_chart`** v0.5.0 | 券商生产级、仍在维护、纯 Dart 无手势冲突 |
| 轻量图表 | `fl_chart` v1.2.0 | Home/卡片走势，零风险 |
| DApp Browser | `flutter_inappwebview` + **`flutter_web3_webview`** | 后者提供 EIP-1193/6963 早期注入，省掉最容易出错的部分 |
| 推送/监控/分析 | `firebase_messaging` / `sentry_flutter` / `posthog_flutter` | 全部官方且极活跃 |
| 法币入金 | WebView 内嵌 MoonPay | **Transak 官方不支持 Flutter**，优先谈 MoonPay |

### 6.4 落地顺序（把风险前置）

**第 1 周必须完成的技术验证（Go/No-Go 关卡）：**

1. **iOS 工程共存验证** —— `privy_flutter`(要求 SPM) + `agora_rtc_engine`/`livekit_client` + `flutter_inappwebview` 在同一个 iOS 工程编译通过并跑通。**这是最可能推翻工期估算的隐蔽风险**
2. **Privy 签 Hyperliquid 域验证** —— 用 `ethSignTypedDataV4` 签一个 `chainId: 1337` / `name: "Exchange"` 的 typed data，确认 Privy 不因 chainId 不在已配置链列表而拒签；并把签名结果拿到 Hyperliquid testnet 校验通过
3. **agent wallet 全链路** —— App 内 Privy 签 `approveAgent` → 后端 agent wallet 用 Python SDK 在 testnet 成功下单

这三条任何一条不通，架构就要调整。**在这三条验证通过之前，不要开始写业务 UI。**

---

## 第七章 · 遗留待确认问题

### 必须实测（无法靠查资料回答）

1. **Privy `ethSignTypedDataV4` 能否签 chainId 1337 的非常规域？** —— 决定 Hyperliquid 能否用 Privy 主钱包授权。本报告全部架构建议的前提
2. **`privy_flutter` + SPM 与其他重型原生插件（Agora/LiveKit/inappwebview）的 iOS 共存性** —— 决定工期
3. **Privy Flutter SDK 的 beta 稳定性** —— 0.x 期间 breaking change 频率、生产环境是否有已知规模化案例。建议直接问 Privy 商务要 Flutter SDK 的生产客户参考与 GA 时间表
4. **`privy-io/flutter-sdk` 仓库 404 的原因** —— 是私有仓库还是已迁移？MIT license 但源码不可得，需要向 Privy 确认是否可申请源码访问。这直接决定"出 bug 时能否自救"

### 需向厂商确认

5. **MoonPay 是否官方支持 Flutter WebView 集成**（尤其 KYC 相机权限与回跳）—— Transak 已明确不支持，MoonPay 需单独确认，否则法币入金无合规后盾
6. **TradingView Charting Library 授权条款**（若最终选 WebView 方案）—— 需申请，有商业条款
7. **Privy 不支持私钥导出** —— 产品侧是否接受？若产品承诺"资产可自主导出/迁移"，与此冲突，需换方案或改叙事
8. **Stream Chat 的自定义消息 API 稳定性** —— v7→v10 已改过两次（`customAttachmentBuilders` 废弃 → `attachmentBuilders` → v10 `StreamComponentFactory`）。Token 卡片消息是产品核心，需确认 v10 的 API 是否稳定，避免每次升级重写

### 本次未覆盖

9. **Para、thirdweb、Dynamic 的 Flutter 支持** —— 均未在 pub.dev 找到官方包，但未逐一核对其官方文档，若要正式排除建议补一轮
10. **Zego 完整包矩阵** —— 已确认 `zego_uikit_prebuilt_live_audio_room` v3.16.10（2026-01-19，官方）存在，但未评估其底层 SDK 与定制自由度
11. **Launchpad 相关链上交互**（打新/认购合约）未评估，取决于具体链与合约设计
12. **`deriv_chart` 的定制自由度** —— 需实际接一版验证：自定义指标、主题、手势能否满足产品要求；pub 分数仅 50 分（文档/规范扣分）对二次开发的影响

---

## 附：数据说明

- pub.dev 数据取自官方 API（`/api/packages/{name}` 与 `/api/packages/{name}/score`），GitHub 数据取自 GitHub REST API，均为 2026-08-21 实时查询
- `dl30` = 最近 30 日下载量，是判断"是否有人在生产环境真用"最可靠的单一指标，比 likes 更难刷
- 标注"超一年未更新"的包：`magic_sdk`(2023-11)、`k_chart`(2023-05)、`coinbase_wallet_sdk`(2024-09)、`flutter_inappwebview` 稳定版(2024-10)、`eth_sig_util`(2022-07)、`web3_provider`(2023-06)、`flutter_injected_web3`(2022-11)、`walletconnect_dart`(2022-06)
