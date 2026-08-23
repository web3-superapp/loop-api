# web3-superapp-prototype

Web3 超级应用（钱包 + 匿名社交 + 行情，"发现→讨论→执行"闭环，临时代号 LOOP）的产品方案页 + 高保真交互原型，用于外包沟通与评审，不含任何真实链上逻辑。

- **项目归属**：Dino / Dinolabs
- **项目路径**：`/Volumes/硬盘/Claude Workspace/项目/dinolabs/web3-superapp-prototype`
- **线上地址**：https://web3-superapp-prototype.vercel.app/

## 已拍板前置决策（2026-08-21）

1. 交易形态：**路线 C** —— 多链现货 + Hyperliquid 永续双形态
2. 正式开发语言：**Flutter**（覆盖 iOS + Android）
3. 原型路径：**两步走** —— HTML 定稿评审 → 再翻 Flutter
4. 本次 HTML 定稿范围：**只画 A 档 47 屏**（全量 103 屏，B/C 档只列清单）
5. Perp 入口：**Market 内分「现货 / 合约」两栏**，底部仍是 6 Tab
6. Chat 形态：**不做 Server/频道/角色权限**，保持会话列表 + 群聊 + 群内语音房
7. 实现策略：**集成优先** —— 钱包、交易、行情、IM、音视频、风控、推送等先采用官方或成熟供应商 SDK/API/托管流程；LOOP 只自研差异化体验、编排与策略。供应商确实不覆盖的能力，须先记录缺口、成本与风险并获项目方批准，不能默认重复开发

## 技术栈

纯静态 HTML/CSS/JS，无构建依赖；原型字体以 base64 内嵌。

## 文件结构

```
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

## 开发

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

当前生成原型包含 **37 个 routed screen fragments**：在 30 屏平台基线上新增 Hyperliquid D1–D7 `#perp-markets`、`#perp-market`、`#perp-order`、`#perp-confirm`、`#perp-positions`、`#perp-orders`、`#perp-position`。Perp HTML 不预置行情、仓位、订单或 PnL 真相；每个 adapter method 的 nested value 必须先通过 exact data-descriptor、known-key、primitive/range、duplicate identity 与 BTC/ETH/SOL Core allowlist 解码，再投影为新冻结 canonical DTO。第七个 `prepareMutationReview` 方法的 outer/binding/error/rechecks 也必须通过同级 exact/frozen projector，Core coin 与 intent revision 必须和请求精确绑定，provider 自定义文案不得进入 UI/F11。accessor、unknown key、colon/HIP-3、畸形数值/字符串/来源/freshness 均在任何事实、操作或 timer 之前 fail closed；missing/pending/malformed/stale 一律清空并禁用操作。D3 的 validated frozen typed intent 精确绑定 D4 与既有 F11；Back/edit、stale revision、reload/BFCache 与 URL 注入只能保留完全相同条款或 fail closed。HIP-3 与第二交易/签名核心禁止，生产 mutation 继续 PENDING/default-deny，Privy 与既有 F11 仍是唯一签名权威/共享确认层。B3/B4/H3/H5 与 I1/I2/I3/I5 平台状态保持不变；F11 与 I3 是共享弹层/状态，不单独计 routed screen。权威口径仍以 `文档/页面清单.md` 为准：A 档 47 屏，全量 103 屏；37 是当前构建 manifest 数，不是全量完成数，F3–F5/F12 与其余 A–I 能力仍待实现。

全部七个 Perp adapter 方法先投影 method-specific canonical request；有参数的响应必须逐项匹配请求的 coin、position identity、side、order type、size、leverage、reduce-only 与 intent revision。即使响应 schema 完全合法，任何 ETH→BTC 或 1.25/20×→9.99/1× 替换也会在渲染和 F11 之前 fail closed。

### 当前 App-wide provider/UI 切片（2026-08-23）

- 通知只投影 Firebase delivery 与 Stream、Hyperliquid、Privy 官方事件；durable inbox、read sync、preferences 与 webhook ingestion 仍由 integration catalog 的 provider selection gate 默认拒绝。
- 搜索仅做最多 4 个注入 provider、每个最多 5 条结果的 bounded fan-out，不创建 LOOP 搜索索引、社交图谱或 ranking store。
- 隐私导出/删除只接受 provider/server async `PENDING` 合同；离线 fixture 明确 `mutation_performed=false`。安全中心只展示 GoPlus、Chainalysis、Privy 事实，不计算自有风险分或安全结论。
- `LoopPlatformOfflineFixture` 不发网络请求、不含凭据、不落持久化数据，也不会回退到生产；生产接入必须复用已审核 provider/官方 SDK/成熟 GitHub 项目，通过 `LoopPlatformProvider` 薄适配层，不在客户端重建 whole-app 基础设施。

### 当前 HTML 钱包基础里程碑（2026-08-23）

- 已覆盖 F1 钱包总览、F2 资产详情、F6 收款、F11 统一 Intent 确认弹层，并让 F16 限额/无限授权与 Swap 共用同一 F11 入口。
- 原型仅使用 `SimulatedPrivyWalletAdapter` 的冻结公开 fixture：**零网络请求、不执行签名、不广播交易、不持有钱包密钥**。页面中的 pending/succeeded 只能是明确标注的模拟 provider fixture。
- 生产接入边界（尚未接入）走 **Privy Wallet Actions + 薄 BFF**：嵌入式 Wallet Actions 由客户端生成用户授权签名，BFF 持有 app secret 并转发请求；只有对应 Privy 官方路径实际提供认证或 MFA 时，产品才显示该控制；外部钱包保留它自己的最终确认。F11 不替代这些 provider controls。当前 Flutter/BFF 路径尚未接入，不得将 HTML fixture 写成已有生产认证或确认层。
- `src/scripts-order.txt` 精确固定十项生产顺序：QR vendor → wallet provider → wallet review → wallet transfer → Stream provider → platform provider → platform offline fixture → Hyperliquid Core read provider → Perp offline fixture → app。两种 offline fixture 都必须显式标注、保持只读且不得伪装 production；`src/test-fixtures/` 被构建器精确排除。`src/screens-order.txt` 决定屏顺序，`src/vendor/vendor-lock.json` 锁定本地 QR 依赖来源；focused verifiers 同时校验生成物、供应商边界、金额精度、历史投影、无障碍与安全扫描。
- **全项目未完成**：Stream 生产薄适配 seam、首批 platform/UI offline 边界与 Hyperliquid Core Perp D1–D7 只读切片已进入静态 runtime，但凭证、官方 SDK、商业/license 与 R0 证据尚未接入，所有 provider 写入继续 fail closed；Hyperliquid 生产执行与其余 A–I 能力仍是 pending / in progress，继续遵循“整 App 成熟方案/官方 SDK/成熟 GitHub 代码集成优先”。

**新增一屏**：在 `src/screens/` 建片段 → 在 `screens-order.txt` 加一行 → `python3 build.py`。

## 原型工程纪律（别翻案）

- `app.html` 是构建产物，一切修改进 `src/`
- URL 是状态的投影：hash / history / 内存栈由一处派生，刷新回到同一位置
- App 内返回沿层级上一级，浏览器返回按真实路径回溯，两者不混用
- 非活动页必须 `inert` + `aria-hidden`，否则 30+ 控件留在键盘焦点顺序里
- 二级页不显示底部 Tab 栏；群聊输入框固定不随滚动
- 技术口径按实际状态写：未接入的写 "Designed for X · simulated in this prototype"
- 每个新切片先做供应商能力审计：官方集成能覆盖的能力只建薄适配层，不在客户端重造钱包、路由、行情、IM、音视频或安全基础设施
- 占位就是占位，不提前交付能力（AI bot / Launchpad / Payment）

## 部署

Vercel CLI 直推（本目录非 git 仓库）。
