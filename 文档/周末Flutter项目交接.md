# LOOP 周末 Flutter 项目交接

> 2026-08-24 · 可直接转发给开发

LOOP 是一个 **Flutter App**，正式目标是 iOS + Android。Web 只用于本地 UI 预览和自动化验收；根目录 HTML 只保留为历史交互/安全契约参考，不再是开发主线。

当前状态：Flutter App 的 UI、路由、领域意图和供应商薄适配边界已经铺齐，可以进入真实服务接入。当前运行的是 Preview/Memory Adapter，**不代表 Privy、Hyperliquid 或 Agora 已经生产打通**。

## 周末完成了什么

- 建立 iOS/Android 共用的 Flutter 正式工程、统一设计系统和六入口主导航：Home、Market、Launch、Chat、Wallet、Profile。
- 建立 103 个产品 surface 的唯一目录和路由；当前非延期能力都已进入专属 Flutter UI，通用范围说明页只保留给明确延期能力。
- 补齐 Account A1–A12、Market C1–C11 有效页、Perp D1–D12、Chat/Voice E1–E12 有效页、Wallet F1–F20 有效页、Launch G1、Profile H1–H16 和系统状态 I1–I8。
- 补齐 Market 的持有人分布、成交活动、自选管理、价格提醒、关注钱包活动，以及 Chat 内 Token 卡、合约事实和资产快照页。
- 建立 Privy、Hyperliquid、Agora 的 Gateway/Adapter 接口与本地预览实现，让 UI 与真实 SDK/API 可替换。
- 建立统一 `SigningIntent` 与 F11 `SigningReviewSurface`；发送、Swap、授权和 Perp 订单不再各自做确认弹层。
- 补齐 loading、empty、offline、stale、error、region blocked、维护、强更、未知提交结果等基础状态。
- 完成键盘焦点、语义标签、reduced-motion、390×844 手机尺寸和 1440×900 宽屏布局验收。

## 这些工作的价值

1. **减少返工**：103 页口径、六 Tab、Perp 入口、支付延期和 Phase 2 边界都被固定，开发不需要重新猜信息架构。
2. **降低资金风险**：Privy 是唯一钱包/签名权威，F11 是唯一 App 意图审查面；过期、非 Core 市场、builder fee 和未知结果都默认拒绝或对账。
3. **避免重造基础设施**：钱包收敛到 Privy，合约收敛到 Hyperliquid，通信收敛到 Agora；LOOP 只做薄适配、编排和差异化体验。
4. **实现与产品口径一致**：页面目录、Router、Theme、Gateway 和测试都在 Flutter 主线，HTML 屏幕数不再被误当成生产进度。
5. **后续可并行**：UI 已有稳定边界，Privy、Hyperliquid、Agora、BFF 可以按 Gateway 分工接入，不会互相重写页面。

## 已确定的边界

| 领域 | 当前决定 |
|---|---|
| 客户端 | Flutter iOS/Android；Web 仅用于本地视觉验收 |
| 导航 | 固定六个主入口；Perp 在 Market 的 Spot/Perp 分栏，不新增第七个 Tab |
| 钱包与签名 | Privy 是唯一授权入口；F11 是 App 统一审阅，最终确认仍由 Privy 承担 |
| 敏感信息 | 恢复短语界面必须经运行时 capability、重新认证和安全屏幕校验；不承诺私钥导出 |
| 交易 | 仅接 Hyperliquid Core BTC/ETH/SOL；不做 HIP-3、builder fee 或第二交易核心 |
| 通信 | 唯一目标是 Agora Chat + RTC（声网）；Stream 仅为旧 HTML/历史文档参考，不双接 |
| 支付 | B5–B8 明确延期，本阶段不开发，首页不放 Pay |
| Phase 2 | E13/E14、F18/F20、G2–G4、H15/H16 只保留 Coming later 与路由 |
| 风险表达 | 只展示可核实事实，不使用「AI 风险分」等不可解释结论 |

## 开发不要重复做

- 不要继续扩旧 HTML，也不要把 Web 预览当成 LOOP 产品。
- 不要重写已有 Router、Theme、六入口 Shell、Surface Catalog、系统状态和通用组件。
- 不要再做第二套签名弹窗、钱包状态机或 Perp 主入口。
- 不要同时接 Stream、腾讯云或其他 IM/RTC；当前统一走 Agora。
- 不要自建钱包、撮合、桥、IM、RTC、Push 或自有风险分基础设施。
- 不要提前实现支付、HIP-3、builder fee 和 Phase 2 能力。
- 不要将当前静态行情、Memory Chat/RTC 和预览订单计为 live 能力。

## 直接从这些文件继续

- `apps/mobile/lib/app.dart`：统一 Router 与全部页面接线
- `apps/mobile/lib/core/navigation/surface_catalog.dart`：103 页唯一目录和优先级
- `apps/mobile/lib/core/theme/loop_theme.dart`：设计 token 与 Flutter Theme
- `apps/mobile/lib/widgets/loop_ui.dart`：公共卡片、数值、状态、上下文轨道与操作栏
- `apps/mobile/lib/core/intent/signing_intent.dart`：统一资金意图与本地策略检查
- `apps/mobile/lib/features/review/signing_review_surface.dart`：F11 唯一 App 签名审阅面
- `apps/mobile/lib/integrations/`：Privy、Hyperliquid、Agora 薄适配边界
- `apps/mobile/test/`：路由、目录、意图和 fail-closed 契约

## 下一步开发清单

1. 分离 Preview 与 Production 启动入口。当前 `main.dart` 明确覆盖为 Preview Adapter，不能直接用于生产。
2. 建设尚未创建的 TypeScript BFF 与环境配置：密钥只在服务端，补短期 token、request correlation、幂等、限流、审计和错误映射。
3. 接 Privy：真实登录/session、embedded/external wallet、MFA/passkey、Agent Wallet、Policies 和运行时 capability 映射。
4. 接 Hyperliquid：官方 API/SDK、REST + WebSocket、精确小数、数据新鲜度、Core 币种白名单、未知提交结果对账及 testnet 流程。
5. 接 Agora：官方 Flutter Chat/RTC SDK、服务端短期 token、与钱包无关的内部 User ID、Push、重连，以及 iOS 音频中断/后台恢复。
6. 将 Home/Market/Wallet 的静态预览换成真实只读数据，保留 loading、empty、stale、error 和 source 标识。
7. 完成真实设备、凭证环境、地区资格、可观测性、安全审计和商店合规验证。

正式联调前建议先完成四个 Go/No-Go：iOS 原生插件同工程编译、Privy 对 Hyperliquid 所需 typed-data 域的签名、`approveAgent + Hyperliquid testnet` 下单、Agora 在 iOS/Android 的 Chat + RTC 短 token 入房。

## 当前验证证据

- `dart analyze lib test`：**0 issue**
- `flutter test`：**9/9 全部通过**
- `flutter build web --release`：构建通过，仅用作 Flutter UI 本地验收证据
- 自动化覆盖：六入口导航、103 个 surface ID/路由唯一、generic fallback 仅限 deferred、F11 单一签名审阅、Preview 禁止提交、Core 币种限制、HIP-3/builder fee/过期意图拒绝
- 390×844 手机与 1440×900 宽屏视觉检查完成；最终运行无 browser console error
- 当前机器缺少 Android SDK、完整 Xcode 和 CocoaPods，因此本轮没有把 iOS/Android native target 编译通过；接手后必须在完整移动端工具链和真实设备上补做

## 目前明确未完成

真实 Privy 授权/签名、Hyperliquid 行情/下单、Agora Chat/RTC、BFF、持久化、Push、生产监控、testnet 端到端和真实设备发布验证。这些是下一阶段的真实工作，不要用静态 Preview 当成已接通。
