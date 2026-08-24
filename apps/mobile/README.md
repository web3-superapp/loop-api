# LOOP Flutter App

LOOP 的正式客户端是 **Flutter App**，目标平台为 iOS 与 Android。`web/` 仅用于本地 UI 自动化与响应式预览，不是独立网页产品，也不是生产交付目标。

正式前端仓库：<https://github.com/web3-superapp/loop-mobile>。历史 HTML 原型和迁移记录仍保留在 <https://github.com/Doog-bot534/web3-superapp-prototype>，不再作为 Flutter 开发入口。

## 当前已完成

- 六个固定主入口：Home / Market / Launch / Chat / Wallet / Profile
- 全量 103 个产品 surface 的路由目录；非延期能力使用专属 Flutter UI，延期能力只显示明确范围说明
- Privy 登录、钱包与唯一签名审查边界
- Hyperliquid Core BTC / ETH / SOL 行情、订单、仓位与账户 UI
- Agora-ready 的 Chat + RTC 薄适配边界、语音房五态与跨页 mini bar
- Account、Wallet、Market、Perp、Chat、Profile 与系统状态组件
- 深色 LOOP 设计系统、键盘焦点、语义标签、reduced-motion 与手机/桌面响应式布局

所有供应商写入默认 fail-closed。当前 preview adapter 只用于 UI 验证，不代表生产登录、签名、下单、聊天或语音已经接通。

## 开发入口

```bash
flutter pub get
dart analyze lib test
flutter test
flutter run
```

Web release build 只用于本地视觉验收：

```bash
flutter build web --release
```

## 不要重复建设

- 不要继续扩展根目录的 HTML 原型；它只是历史交互与安全契约参考
- 不要重新搭 Flutter 路由、主题、六 Tab 壳层、页面目录或通用状态组件
- 不要新建第二套交易确认弹层；所有资金意图统一进入 F11 `SigningReviewSurface`
- 不要把 Perp 做成第七个底部 Tab；入口固定在 Market 的现货 / 合约分栏
- 不要自建钱包、撮合、桥、IM 或 RTC 基础设施；只实现已选供应商的薄适配与 LOOP 编排
- 不要启用 Hyperliquid HIP-3、builder fee 或非 Core 市场
- 支付当前明确延期，不要把 Pay 重新放回首页主路径

下一阶段应集中在真实 Privy、Hyperliquid、Agora、BFF、推送与行情数据接入，以及 testnet / 真机验证，而不是重复 UI 基础工程。
