#!/usr/bin/env python3
"""在方案页正文插入 2026-08-21 的选型与排期定稿一节。"""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
p = root / 'index.html'
s = p.read_text()

ANCHOR = '## 九、已拍板决策记录（别翻案）\n'
assert s.count(ANCHOR) == 1

NEW = """## 九、技术选型与交付计划（2026-08-21 定稿）

四份选型调研已完成，交付计划已排定。完整文档见 [交付文档页](./docs.html)。

### 9.1 选型结论

| 层 | 选定 | 月成本（1万 / 10万 DAU） | 备注 |
|---|---|---|---|
| 开发语言 | **Flutter**（iOS + Android） | — | 有条件可行，见 9.3 |
| 嵌入式钱包 / 登录 / MFA | **Privy**（有官方 Flutter SDK） | $499 / 需议价 | 1 万 MAU 即触发 Enterprise 议价 |
| 交易签名与执行 | **自建后端 + Hyperliquid 官方 Python SDK** | 含服务器成本 | Dart 侧无 Hyperliquid SDK，必须下沉后端 |
| 现货 Swap / 跨链 | **Privy 内置**（Uniswap API + Relay） | 免费 | 不接第三方聚合器，省 8~12 人日 |
| Perp | **Hyperliquid 核心白名单市场** | API 免费 | 需申请 builder code 才能抽成（上限 0.1%） |
| IM + 语音房 | **Stream**（Chat + Video） | $2,000~2,800 / $4,000~9,000 | 20 万人群功能降级问题待厂商书面答复 |
| 钱包资产 / RPC / 交易模拟 | **Alchemy** | $200 / $800 | 交易模拟用它替代 Blockaid，省约 $3,000/月 |
| 行情 | **CoinGecko Analyst + DexScreener + Birdeye** | $328 / $698 | CoinGecko 免费档禁商用，必须付费档 |
| 合约事实 / 蜜罐 / 授权盘点 | **GoPlus** | $199 / $799 | 保留能力，去掉"AI 风险分"呈现 |
| 制裁地址筛查 | **Chainalysis** | 免费 | 合规底线 |
| K 线图表 | **deriv_chart**（券商级开源） | 免费 | 无 TradingView 官方 Flutter 方案 |
| 法币出入金 | **MoonPay** | 免费接入 | Transak 官方不支持 Flutter，已出局 |
| 推送 / 监控 / 分析 | Firebase + Sentry + PostHog | 免费档 | 均有官方 Flutter SDK |

合计：开发期约 **$1,000~1,500/月**，1 万 DAU 约 **$3,600~5,000/月**，10 万 DAU 约 **$9,000~15,000/月**。

### 9.2 本轮新增的三条拍板

1. **Perp 只做 Hyperliquid 核心白名单市场**，不做 HIP-3 自建市场（后者无许可发币，已有 rug 事故）。入口走 Market 内「现货 / 合约」分栏，底部仍是 6 Tab
2. **安全层去掉"AI"包装，保留钱包基础能力**——不显示风险分、不做 AI Guard 品牌，但无限授权拦截、交易前模拟、地址风险校验、授权盘点回收一项不少。这些是钱包的基本义务，不是 AI 功能。呈现方式从"AI 风险分 72/100"改为具体事实陈述
3. **Chat 不做 Discord 式频道体系**（Server / 频道分类 / 角色权限），保持会话列表 + 群聊 + 群内语音房。冷启动策略确定后再评估

### 9.3 三个必须让所有人知道的结构性限制

| # | 限制 | 后果 |
|---|---|---|
| 1 | **iOS 上不了永续合约** | Apple 3.1.5(iv) 要求加密期货 App 由持牌银行/证券/FCM 提交。旁证：Hyperliquid 官方 App 只发了 Android，iOS 至今未上。正式上架时 iOS 必须去掉 perp 下单 |
| 2 | **所有法币通道不支持中国大陆用户与 CNY** | Transak / MoonPay / Ramp / Banxa / Mercuryo 全部如此。若目标用户含中国大陆，出入金这条路走不通 |
| 3 | **换钱包供应商会连带弄断社交图谱** | 更换供应商必然更换用户地址，而社交身份建在地址上。对策：**身份系统用内部 user id 做主键，地址作可挂载凭证**，必须在写第一行身份代码前定下 |

### 9.4 交付计划

30 个工作日（6 周），AI 生成代码 + 人工审核，交付内测版（TestFlight + APK，接真实 API，资金路径走 testnet），**不含安全审计与上架审核**。

审核预算 105 小时（每天 3.5h × 30 天），需求 85 小时，缓冲 19%。其中**资金相关代码占 39 小时**——签名、精度、强平价、授权额度必须逐行读并人工复算，这部分不随 AI 变快，是整个计划的吞吐瓶颈。

六周节奏：验证与地基 → 账户与钱包 → 现货闭环 → Chat 与语音 → Perp → 补齐加固。

**第 1 周不产出业务 UI，排的是三个 Go/No-Go 验证**（iOS 工程共存、Privy 能否签 chainId 1337、agent wallet 全链路 testnet）。任何一条不通，架构与工期都要重估——这是刻意把最可能推翻计划的风险前置。

配套测试用例 151 条，其中 89 条 P0（资金安全 24 条 + 核心闭环 6 条 + 各模块）。

### 9.5 待厂商答复的三项

| 对象 | 问题 | 影响 |
|---|---|---|
| **Stream** | 单 channel 到 20 万成员时，@提及 / 已读 / 表情反应 / 搜索是否降级？ | 官方"百万 watcher"指直播弹幕场景。若会降级，要么改产品需求，要么换腾讯云 IM |
| **Privy** | Enterprise 报价 | 1 万 MAU 即触发 |
| **Privy** | 内置 Swap 能否设置 affiliate fee？ | **若不能，现货侧无交易收入**，只剩 perp 的 builder fee |

---

## 十、已拍板决策记录（别翻案）
"""

s = s.replace(ANCHOR, NEW)
p.write_text(s)
print('inserted section 9; old section 9 renumbered to 10')
