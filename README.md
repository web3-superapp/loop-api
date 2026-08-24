# web3-superapp-prototype

Web3 超级应用（钱包 + 匿名社交 + 行情，"发现→讨论→执行"闭环，临时代号 LOOP）的 Flutter 客户端、BFF 与产品/交互参考。

- **项目归属**：Dino / Dinolabs
- **项目路径**：`/Volumes/硬盘/Claude Workspace/项目/dinolabs/web3-superapp-prototype`
- **线上地址**：https://web3-superapp-prototype.vercel.app/

## 当前代码仓库

- **Flutter 前端**：https://github.com/web3-superapp/loop-mobile
- **BFF 后端**：https://github.com/web3-superapp/loop-api
- 本仓库保留周末原型、迁移历史和产品契约；新功能分别进入上述前后端仓库，避免继续扩成混合仓库

## 已拍板前置决策（2026-08-21）

1. 交易形态：**路线 C** —— 多链现货 + Hyperliquid 永续双形态
2. 正式开发语言：**Flutter**（覆盖 iOS + Android）
3. 交付路径：**直接开发 Flutter 客户端 + BFF + 自动化测试**；现有 HTML 只作为已验收的交互与安全契约参考，不再是 Flutter 开发的前置关卡
4. 实现范围：先完成 A 档 47 屏与三大核心集成，再按同一架构扩展全量 103 屏
5. Perp 入口：**Market 内分「现货 / 合约」两栏**，底部仍是 6 Tab
6. Chat 形态：**不做 Server/频道/角色权限**，保持会话列表 + 群聊 + 群内语音房
7. 实现策略：**集成优先** —— 钱包、交易、行情、IM、音视频、风控、推送等先采用官方或成熟供应商 SDK/API/托管流程；LOOP 只自研差异化体验、编排与策略。供应商确实不覆盖的能力，须先记录缺口、成本与风险并获项目方批准，不能默认重复开发

## 技术栈

- `apps/mobile`：当前有效交付，Flutter iOS/Android 客户端；Privy、Hyperliquid、Agora Chat + RTC 为三个核心接入边界
- `apps/api`：计划中，TypeScript BFF；保存供应商密钥、签发通信 token、编排 Hyperliquid 与应用级集成
- `packages`：计划中，可复用 Flutter 领域包
- `src` / `app.html`：历史 HTML 交互参考，不承载生产请求、签名或状态权威

> **当前通信决策**：Flutter App 以 **Agora Chat + RTC（声网）** 为唯一接入目标。下方 Stream 内容只记录已冻结 HTML 参考的历史实现，不是 Flutter 开发指令，不要双接或重复建通信层。

## 文件结构

```
apps/mobile/             Flutter 客户端
apps/api/                Node/TypeScript BFF（计划中，未创建）
packages/                Flutter 领域包（计划中，未创建）
index.html              产品方案页（中文，深色+薄荷绿，marked.js 渲染，含原型深链）
app.html                交互原型 —— 构建产物，勿手改
docs.html               交付文档页 —— 构建产物，勿手改
build.py                从 src/ 合并出 app.html
build_docs.py           从固定 Markdown 与本地 Marked 生成 docs.html
fonts.css               base64 内嵌字体
src/
  head.html             <meta> 与 <title>
  style.css             全部样式，含 <!--FONTS--> 占位
  shell-open.html       pitch 侧栏 + phone 壳 + viewport 开
  screens/*.html        每屏一个片段
  screens-order.txt     屏序的唯一真相
  scripts-order.txt     生成脚本顺序的唯一真相
  vendor/vendor-lock.json  本地第三方脚本的版本、来源、license 与 SHA-256
  wallet-provider.js    Privy 供应商薄适配边界（原型内为冻结 fixture）
  wallet-review.js      LOOP 统一 Intent 解码与 F11 一次性 review controller
  wallet-transfer.js    F3–F5/F12 冻结路由壳 facade（无业务状态或 provider 行为）
  stream-chat-provider.js  Stream Chat/Video 生产薄适配 seam（凭证前 fail closed）
  test-fixtures/stream-chat-offline-fixture.js  仅测试加载的冻结离线 fixture，不进 app.html
  shell-close.html      固定层：群聊头/输入框/全局通话条/tabbar/sheets/toast
  app.js                全部脚本
文档/
  页面清单.md            全量 103 屏清单（测试用例与进度表的共同地基）
docs_vendor/            文档页专用的官方 Marked bundle、MIT LICENSE 与精确 vendor lock
调研/                    第三方付费集成方案选型报告
```

## Flutter App 开发

```bash
cd apps/mobile
flutter pub get
dart analyze lib test
flutter test
flutter run
```

Flutter 主线、页面边界和不要重复建设项见 `apps/mobile/README.md`；开发交接见 `文档/周末Flutter项目交接.md`。

## 历史 HTML 参考维护（非开发主线）

```bash
python3 build.py                    # 改了 src/ 后重新生成 app.html
open index.html                     # 看方案页
open app.html                       # 看原型
python3 _tmp/verify_split.py        # Playwright 回归测试（路由/闭环/语音房/无障碍）
python3 _tmp/verify_account.py      # 账号引导回归（流程/安全/无障碍/移动布局）
python3 _tmp/verify_wallet_foundation.py  # F1/F2/F6/F11/F16 focused 安全与交互验证
python3 _tmp/verify_wallet_transfer.py    # F3–F5/F12 路由壳、manifest 与安全边界
python3 _tmp/verify_stream_chat.py        # Stream 合同、薄适配器与生产 bundle 边界
python3 _tmp/verify_platform_ui.py        # B3/B4/H3/H5 + I1/I2/I3/I5 provider/UI 边界
python3 build_docs.py && python3 _tmp/verify_docs.py  # 文档生成与口径回归
```

`docs.html` 内嵌 `docs_vendor/vendor-lock.json` 精确固定的官方 npm `marked@18.0.10` UMD 字节，不依赖 CDN；`build_docs.py` 在生成前校验 bundle 与 MIT LICENSE 的 SHA-256。若 Marked API 不兼容或解析异常，页面以 `textContent` 回退显示 Markdown 原文。

当前生成原型包含 **42 个 routed screen fragments**：在已验收的 37 屏 Stream + Hyperliquid D1–D7 主线上加入 Hyperliquid D8–D12。D1–D7 保持 Core 市场、订单与仓位切片；D8–D12 新增 `#perp-account`、`#perp-transfer`、`#perp-deposit`、`#perp-funding`、`#perp-risk-notice`。账户、资金费、桥上下文与风险声明只从独立 Hyperliquid account adapter 的 deep exact/frozen canonical DTO 投影，HTML 不保存 provider 数值或账户真相；每个响应逐项绑定原始 account/asset/network/coin/context revision，accessor、unknown key、HIP-3、畸形数值、响应替换与当前时间下的 stale 均清空事实并禁用操作。D9/D10/D12 的输入只形成不可变 typed Intent，再由同一 mutation gate 复核；当前生产 credentials/eligibility 仍为 PENDING/default-deny，因此在任何签名调用前停止。D10 仅表达官方 Hyperliquid bridge 的充值/提现边界，通用跨链仍归 Privy/Relay，不新增 router、ledger 或 bridge。Privy 与现有 F11 继续是唯一签名权威/共享确认层，HIP-3、builder fee、第二交易核心与第二签名弹层禁止。权威口径仍以 `文档/页面清单.md` 为准：A 档 47 屏，全量 103 屏；42 是当前 post-Stream 组合构建 manifest 数，不是全量完成数。

全部七个 Perp adapter 方法先投影 method-specific canonical request；有参数的响应必须逐项匹配请求的 coin、position identity、side、order type、size、leverage、reduce-only 与 intent revision。即使响应 schema 完全合法，任何 ETH→BTC 或 1.25/20×→9.99/1× 替换也会在渲染和 F11 之前 fail closed。

> **历史 HTML 归档 — Stream E1–E4 final semantic composition（2026-08-24）**：已验收 Stream 检查点为 **37 screens / 10 scripts**；加入 D8–D12 后的组合构建固定为 **42 screens / 12 scripts**。在这份已冻结 HTML 原型内部，Stream Chat/Video 曾是聊天、语音与 presence 的 provider 边界；**Flutter App 不继承该供应商决定，统一接 Agora Chat + RTC**。历史原型的所有 Stream writes 继续 `PENDING`/fail closed，navigation、history、session 与 F11 都不得持久化 RTC/presence-shaped 状态。Token Card → Buy → Swap → F11 → Privy 仍走既有唯一签名确认层；Perp 的 TTL、typed intent、request-response correlation 与单一 F11 边界保持不变。

### 当前 App-wide provider/UI 切片（2026-08-23）

- 历史 HTML 的通知切片只投影 Firebase delivery 与 Stream、Hyperliquid、Privy 官方事件；Flutter 通信与通知后续统一按 Agora + Push 的当前方案接入。
- 搜索仅做最多 4 个注入 provider、每个最多 5 条结果的 bounded fan-out，不创建 LOOP 搜索索引、社交图谱或 ranking store。
- 隐私导出/删除只接受 provider/server async `PENDING` 合同；离线 fixture 明确 `mutation_performed=false`。安全中心只展示 GoPlus、Chainalysis、Privy 事实，不计算自有风险分或安全结论。
- `LoopPlatformOfflineFixture` 不发网络请求、不含凭据、不落持久化数据，也不会回退到生产；生产接入必须复用已审核 provider/官方 SDK/成熟 GitHub 项目，通过 `LoopPlatformProvider` 薄适配层，不在客户端重建 whole-app 基础设施。

### 当前 HTML 钱包基础里程碑（2026-08-23）

- 已覆盖 F1 钱包总览、F2 资产详情、F6 收款、F11 统一 Intent 确认弹层，并让 F16 限额/无限授权与 Swap 共用同一 F11 入口。
- 原型仅使用 `SimulatedPrivyWalletAdapter` 的冻结公开 fixture：**零网络请求、不执行签名、不广播交易、不持有钱包密钥**。页面中的 pending/succeeded 只能是明确标注的模拟 provider fixture。
- 生产接入边界（尚未接入）走 **Privy Wallet Actions + 薄 BFF**：嵌入式 Wallet Actions 由客户端生成用户授权签名，BFF 持有 app secret 并转发请求；只有对应 Privy 官方路径实际提供认证或 MFA 时，产品才显示该控制；外部钱包保留它自己的最终确认。F11 不替代这些 provider controls。当前 Flutter/BFF 路径尚未接入，不得将 HTML fixture 写成已有生产认证或确认层。
- `src/scripts-order.txt` 精确固定十二项生产顺序：QR vendor → wallet provider → wallet review → wallet transfer → Stream provider → platform provider → platform offline fixture → Hyperliquid Core read provider → Perp offline fixture → Hyperliquid account provider → account offline fixture → app。offline fixture 都必须显式标注、保持只读且不得伪装 production；`src/test-fixtures/` 被构建器精确排除。`src/screens-order.txt` 决定屏顺序，`src/vendor/vendor-lock.json` 锁定本地 QR 依赖来源；focused verifiers 同时校验生成物、供应商边界、金额精度、历史投影、无障碍与质量扫描。
- **历史 HTML 状态**：Stream seam、首批 platform/UI offline 边界与 Hyperliquid Core Perp D1–D12 切片已进入静态 runtime，但不会继续扩展为生产客户端。Flutter 的 Privy、Hyperliquid、Agora 真实集成仍未完成，继续遵循“官方 SDK / 成熟集成优先”。

**新增一屏**：在 `src/screens/` 建片段 → 在 `screens-order.txt` 加一行 → `python3 build.py`。

## 历史 HTML 原型工程纪律（仅维护参考时使用）

- `app.html` 是构建产物，一切修改进 `src/`
- URL 是状态的投影：hash / history / 内存栈由一处派生，刷新回到同一位置
- App 内返回沿层级上一级，浏览器返回按真实路径回溯，两者不混用
- 非活动页必须 `inert` + `aria-hidden`，否则 30+ 控件留在键盘焦点顺序里
- 二级页不显示底部 Tab 栏；群聊输入框固定不随滚动
- 技术口径按实际状态写：未接入的写 "Designed for X · simulated in this prototype"
- 每个新切片先做供应商能力审计：官方集成能覆盖的能力只建薄适配层，不在客户端重造钱包、路由、行情、IM、音视频或安全基础设施
- 占位就是占位，不提前交付能力（AI bot / Launchpad / Payment）

## 历史 HTML 参考部署

以下只更新 Vercel 上的历史 Web 参考，不等同于 Flutter App 发布。

如需更新历史参考站，使用其既有 Vercel 项目；Flutter App 走 iOS / Android 的独立构建与发布流程。
