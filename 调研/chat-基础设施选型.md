# LOOP Chat 基础设施选型报告

> 调研日期：2026-08-21｜前提：Flutter（iOS+Android）、不写核心代码只做组装、愿付费、团队在中国、产品面向海外
> 已拍板：不做 Discord 式频道体系。形态 = 会话列表（群聊+私聊）+ 群聊消息流 + 群内内嵌语音房

## 一句话结论

**主推「腾讯云 IM（海外数据中心）+ TRTC 语音房」**——它是唯一一个单群原生支持 20 万人且带历史消息漫游的商业方案（Community 群默认 10 万、企业版可申请扩到 100 万），自定义消息（customElem 任意 payload）+ UserSig 自签发身份 + 官方 Flutter SDK 全部满足，且通过中国站控制台购买海外数据中心套餐是 **按 DAU 计费**，10 万 DAU 档比按 MAU 计费的欧美厂商便宜一个量级。

**次选「Stream Chat + Stream Video」**——Flutter SDK 与 UI 组件质量是全场最好的（官方 `stream_chat_flutter` + `stream_video_flutter`，自定义 attachment builder 天然适配 Token 卡片），语音房单价也最低（$0.30/千参与者分钟），但 20 万人单群带完整消息语义（reaction/回复/已读）需要跟销售确认，官方公开材料里的「百万 watcher」指的是直播观众场景。

关键淘汰：**Agora Chat（群上限 5000，直接判死）**、**XMTP / Push / Waku（大群与结构化消息均不成熟）**、**Matrix 自托管（20 万人房间 + Flutter 端性能是研究课题，不是组装工作）**。

## 主对比表

| 候选 | Flutter SDK | 20万人单群 | 群内语音房 | 自定义 payload | 自定义身份/匿名 | 中国可开发 | 综合 |
|---|---|---|---|---|---|---|---|
| **腾讯云 IM 国际版** | ✅ 官方 `tencent_cloud_chat_sdk`（7.x 活跃）+ TUIKit UI 库 | ✅ Community 默认 10 万，企业版可扩至 100 万，带历史漫游 | ✅ 同厂 TRTC 语音房组件，需另配另计费 | ✅ customElem 任意二进制/JSON | ✅ UserSig（HMAC-SHA256 服务端签发），无需手机/邮箱，昵称可随时改 | ✅ 原生无障碍 | **首选** |
| **Stream（Chat+Video）** | ✅ 最成熟，官方 UI kit + `attachmentBuilders` 自定义渲染 | ⚠️ 宣称无硬上限、支持百万 watcher，但完整消息语义需销售确认；@提及/已读历史上 >100 成员受限 | ✅ 同厂 Stream Video 有 Audio Room 教程 | ✅ `Attachment.type` + `extraData` 任意 JSON | ✅ JWT | ⚠️ 未被墙但无国内节点，开发期延迟 | **次选** |
| **Sendbird** | ✅ 官方 `sendbird_chat_sdk` 4.x | ⚠️ Supergroup 官方文档口径 2000～「数万，取决于套餐」，20 万无依据 | ⚠️ Sendbird Live 需单独签约，定价未公开 | ✅ `customType` + `data` 字段 | ✅ Session token/JWT | ⚠️ 同上 | 容量存疑 |
| **CometChat** | ✅ 官方 Flutter SDK | ⚠️ 10 万上限但必须关掉已读回执/输入中/送达；全功能群仅 300 人 | ✅ 内置语音通话 $0.001/min，但建议 ≤50 人 | ✅ 自定义消息 | ✅ | ⚠️ | 语音房不够 |
| **Agora Chat** | ✅ 官方 | ❌ 群成员上限：企业版默认 5000；聊天室 2 万 | ✅ 同厂 Agora RTC | ✅ | ✅ | ✅ | **淘汰** |
| **Matrix 自托管** | ⚠️ `matrix-dart-sdk`（社区/Famedly），非商业支持 | ❌ 大房间 state resolution 是已知瓶颈，20 万成员无先例 | ⚠️ Element Call 需自己接 LiveKit | ✅ 自定义 event type（最自由） | ✅ | ✅ | **淘汰**（违反「不写核心代码」） |
| **XMTP / Push / Waku** | ⚠️ `xmtp_plugin` 社区包 1.x | ❌ 大群仍在 RFC 阶段（广播频道方案下普通成员只能反应不能发言） | ❌ 无 | ✅ | ✅ 钱包原生 | ✅ | **淘汰** |

## 3 个推荐组合

语音房成本统一按题设假设计算：**每天 2 场 × 500 人 × 60 分钟 = 6 万参与者分钟/天 ≈ 180 万分钟/月**。这是本项目 RTC 成本的主导项，注意它与 DAU 无关（500 人房是固定的），所以两档 DAU 下语音成本相同。

### 组合 A「最快落地」＝ 腾讯云 IM 海外版 + TRTC 语音房 + TUIKit

- **服务**：腾讯云 Chat（Community 群，海外数据中心）+ TRTC 语音聊天室 + 官方 TUIKit（Flutter UI 组件）
- **月成本量级**：
  - 1 万 DAU：IM 约 ¥3,000～6,000（中国站海外数据中心套餐）+ TRTC 语音 180 万分钟 × $0.99/千分钟 ≈ **$1,780** → 合计约 **$2,200～2,600/月**
  - 10 万 DAU：IM 旗舰套餐 ¥17,999（限时 ¥11,999）≈ $1,650～2,480 + 语音 $1,780 → 合计约 **$3,400～4,300/月**
- **必须自己写的胶水代码**：
  1. UserSig 签发服务（钱包签名验签 → 校验 nonce → 签发 UserSig），这是匿名身份的核心，必须自建
  2. Token 卡片渲染层：消息文本正则扫 `$TICKER` / `0x` 地址 → 调行情/风险分 API → 构造 customElem；接收端按 customElem 的 `businessID` 分发到自定义 Widget
  3. 行情数据聚合与缓存（价格/流动性/持有人数/AI 风险分不是 IM 的职责）
  4. 别名轮换：IM 侧改 nickname 同时要处理历史消息上的旧别名展示策略
  5. 语音房与群的绑定关系（哪个群对应哪个 TRTC 房间号、麦位管理、主持人权限）——TUIKit 的语音房组件是独立的，跟群聊消息流的「同屏共存」布局要自己拼
  6. AI bot：走 REST API（Server API）发消息
- **主要风险**：TUIKit 的 Flutter 组件定制到 LOOP 的视觉规范要改不少样式；中国站 vs 国际站两套控制台/计费口径容易买错（见下方遗留问题）；20 万人群需提前工单申请扩容，大型 AMA 活动要提前 3 天报备资源。

### 组合 B「最省钱」＝ 腾讯云 IM 海外版 + LiveKit Cloud 语音房

- **服务**：IM 同上，语音房换成 LiveKit Cloud
- **月成本量级**：语音 180 万分钟在 LiveKit Scale 档（$500 含 150 万分钟，超出 $0.0004/min）≈ **$500 + 30万×$0.0004 = $620**，另计带宽（音频 ~20-30kbps，180 万分钟约 0.5-0.8TB，Scale 含 3TB，够用）
  - 1 万 DAU：约 **$1,000～1,500/月**
  - 10 万 DAU：约 **$2,300～3,100/月**
- **省钱幅度**：语音部分比 TRTC 便宜约 65%（$620 vs $1,780），比 Stream Video 的 $540 略贵但可自托管兜底
- **必须自己写的胶水代码**：组合 A 全部 + 额外：
  7. LiveKit 房间 token 签发（另一套 JWT，与 IM 的 UserSig 并行）
  8. 麦位/举手/主持人权限的业务逻辑——LiveKit 是纯 SDP/媒体层，没有「语音房」业务概念，麦位状态机要自己写（可用 LiveKit 的 participant metadata 或直接用 IM 的自定义消息同步麦位状态）
  9. 语音房 UI 全自建（LiveKit Flutter SDK 只给 track 渲染，无成品语音房 UI）
- **主要风险**：麦位管理自研是这个组合最大的隐性工作量，跟「只做组装」的原则相悖；两套身份系统增加复杂度。若语音房是核心场景，省下的 $1,000/月未必值得。

### 组合 C「Flutter 支持最好」＝ Stream Chat + Stream Video

- **服务**：Stream Chat + Stream Video（同一厂商、同一套 Flutter 生态、同一份 JWT）
- **月成本量级**：
  - 1 万 DAU（约 3 万 MAU）：Chat 约 $499 起 + 超额 MAU（$0.05～0.09/MAU）≈ $1,500～2,300；Video 音频 180 万分钟 × $0.30/千分钟 = **$540** → 合计约 **$2,000～2,800/月**
  - 10 万 DAU（约 30 万 MAU）：按 list price 线性外推会到 $15,000+，实际必然走 Enterprise 议价，量级约 **$4,000～9,000/月**
- **必须自己写的胶水代码**：组合 A 的第 1～4、6 项（UserSig 换成 JWT，更简单），加：
  7. Token 卡片走 `Attachment(type:'token_card', extraData:{...})` + 自定义 `StreamAttachmentWidgetBuilder`——这是 Stream 的标准扩展点，工作量最小
  8. 会话列表预览：已知限制，自定义 attachment 在频道列表的最后一条消息预览里不会自动显示，需自己处理（GitHub issue #2421）
- **主要风险**：**20 万人单群是这个组合的最大不确定性**。Stream 的「百万 watcher」与 Dynamic Partitioning 是为直播弹幕场景设计的，成员分区后 @提及、已读、成员列表的行为需要跟销售逐项确认；历史上 >100 成员的频道会禁用已读回执和 @提及。10 万 DAU 档定价不透明，议价结果决定这个组合是否可行。

## 直接淘汰的候选

| 候选 | 一句话原因 |
|---|---|
| **Agora Chat** | 群成员上限 5000（企业版默认），差 20 万一个量级，硬门槛不达标 |
| **XMTP** | 大群仍是 RFC 阶段，广播频道方案下普通成员只能「反应」不能发言，不满足社区群聊形态 |
| **Push Protocol / Dialect / Waku** | 无成熟 Flutter SDK、无大群、无语音房；Dialect 偏 Solana 通知，Waku 是传输层不是 IM |
| **Matrix 自托管（Synapse + Element Call）** | 20 万成员房间的 state resolution 性能是未解课题，Flutter 端 `matrix-dart-sdk` 是社区维护且大量数据下有已知内存/启动性能问题——这是研究工作不是组装工作，违反团队约束 |
| **Rocket.Chat / Mattermost** | 定位团队协作（工作区/频道/席位计费），面向 C 端海量匿名用户的模型不匹配，且移动端 Flutter 无官方 SDK（只有成品 App） |
| **Tinode** | 开源但生态小、无商业支持、Flutter SDK 非官方，大群与语音房均需自研 |
| **PubNub / Ably** | 是消息传输层（pub/sub）而非 IM，会话列表、历史漫游、已读、reaction、成员管理全要自建，等于半自研 IM |
| **融云 / 环信 / 网易云信** | 国内三家能力上可满足（环信=Agora Chat 同源、融云有超级群），但海外节点覆盖与合规文档弱于腾讯国际版，且产品面向海外时国内厂商的出海链路是额外风险；若最终倾向国产，融云超级群值得作为腾讯的备选比价 |
| **CometChat** | 10 万人群必须关闭已读/输入中/送达状态，全功能群仅 300 人；语音房建议 ≤50 人，AMA 场景不达标 |

## 定价明细表

| 项目 | 价格 | 来源 | 查询日期 |
|---|---|---|---|
| 腾讯云 Chat 国际版套餐 | Free 1,000 MAU / Standard $399（1万 MAU）/ Pro $699（1万）/ Pro Plus $1,299（2.5万）/ Enterprise 议价（5万） | https://www.tencentcloud.com/document/product/1047/34349 | 2026-08-21 |
| 腾讯云 Chat 国际版超额 | 超额 MAU $0.05/MAU/月；社群消息下发 $20/千万条（2026-04-01 起超额 MAU 费率有调整，需看公告） | https://www.tencentcloud.com/document/product/1047/67651 | 2026-08-21 |
| 腾讯云 Chat 中国站·海外数据中心套餐 | ¥2,999 / ¥5,999 / ¥17,999 每月（限时 ¥11,999）；**按 DAU 计费**，免费额度 1万或10万 DAU/月，超额 ¥3,000/万 或 ¥3,000/十万；消息超额 ¥150/千万条 | https://cloud.tencent.cn/document/product/269/116070 | 2026-08-21 |
| 腾讯云 IM 群类型容量 | Community 社群默认 10 万人，企业版工单可扩至 100 万，支持历史消息；AVChatRoom 直播群无上限但不存历史；单用户可加 1,000 个社群 | https://www.tencentcloud.com/document/product/1047/33529 | 2026-08-21 |
| TRTC 国际版音频时长 | **$0.99/千分钟**（纯音频）；HD 视频 $3.99/千分钟；每账号每月 10,000 分钟免费 | https://www.tencentcloud.com/document/product/647/42734 | 2026-08-21 |
| Stream Chat 套餐 | Free/Maker（1,000～2,000 MAU，100 并发连接，不含推送）；Start 约 $399/月（年付）或 $499/月（月付），约 1万 MAU、500 并发；Elevate 约 $675；Enterprise 议价。超额 MAU $0.05～$0.15（可议），并发连接超额约 $0.79～$0.99/个；**推送通知为独立 add-on** | https://getstream.io/chat/pricing/（WebFetch 受限，数据来自第三方汇总）https://www.vendr.com/marketplace/getstream | 2026-08-21 |
| Stream Video | **音频 $0.30/千参与者分钟**；SD $0.75、HD $1.50、1080p $3.00；RTMP $0.015/编码分钟；录制 $0.003～0.006/分钟；每账号每月 $100 免费额度 | https://getstream.io/blog/daily-comparison/ | 2026-08-21 |
| Sendbird | Developer $0（100 MAU 永久 / 1,000 MAU 试用 30 天）；Starter $399/月（5,000 MAU）；Pro $599/月（含搜索/webhook/导出）；Enterprise 议价。超额 MAU 约 $0.010～0.012；扩展留存 +$5,000～20,000/年 | https://sendbird.com/pricing（WebFetch 受限）https://www.vendr.com/marketplace/sendbird | 2026-08-21 |
| Sendbird Supergroup 容量 | 普通群 100 人上限；Supergroup 官方 Platform API 写 2,000，SDK 文档写「超过 2,000，可达数万，取决于套餐」 | https://docs.sendbird.com/docs/chat/sdk/v3/javascript/tutorials/supergroup-channel | 2026-08-21 |
| Agora Chat | Free 500 MAU/50 并发；约 $349/月（1千 MAU）、$699/月（1万 MAU）；超额 $0.05/MAU。**群成员上限：Free 100 / Starter 250 / Pro 1,000 / Enterprise 默认 5,000**；聊天室 Enterprise 默认 2 万 | https://docs.agora.io/en/agora-chat/reference/pricing-plan-details | 2026-08-21 |
| Agora RTC | 音频 $0.99/千分钟；HD 视频 $3.99/千分钟 | https://trtc.io/blog/details/agora-pricing-2026 | 2026-08-21 |
| LiveKit Cloud | Build $0（5,000 分钟）/ Ship $50（15 万分钟，超额 $0.0005/min）/ Scale $500（150 万分钟，超额 $0.0004/min）/ Enterprise 议价。带宽 50GB/250GB/3TB，超额 $0.12 或 $0.10 /GB | https://trtc.io/blog/details/livekit-pricing-2026 | 2026-08-21 |
| CometChat | Build 免费 100 MAU/25 并发；Basic 约 $239～299/月（1千 MAU）；Advanced 约 $339～449/月；Enterprise 约 $1,249/月起（1万+ MAU）；超额 $0.10/MAU。语音 $0.001/min、视频 $0.003/min、录制 $0.006/min，1 万免费测试分钟。**全功能群 300 人；关闭已读/输入中可至 10 万** | https://www.cometchat.com/pricing.md｜https://docs-classic.cometchat.com/docs/fundamentals/limits | 2026-08-21 |

> 说明：Stream 与 Sendbird 官网 pricing 页在本次调研环境下 WebFetch 被拒，上表数据取自厂商 blog、Vendr 采购数据库与第三方 2026 汇总，**签约前必须以官网/销售报价复核**。10 万 DAU 档所有厂商均为 Enterprise 议价区间，无公开定价。

## 逐维度补充结论

**Flutter SDK**：腾讯 `tencent_cloud_chat_sdk`（7.x，pub.dev 活跃）+ `tim_ui_kit` TUIKit；Stream `stream_chat_flutter` 10.x + `stream_video_flutter`，是四家里 UI 组件化最彻底的。自定义消息渲染两家都是一等公民：腾讯按 customElem 的 businessID 分发，Stream 用 `StreamAttachmentWidgetBuilder`（注意 v7 起 `customAttachmentBuilders` 已废弃改为 `attachmentBuilders`）。

**大群容量与扇出**：腾讯 Community 群是「社群」模型（带历史漫游、可加 1000 个），不是全员长连接推送，20 万人是官方支持规格。AVChatRoom（直播群）无人数上限但不存历史，适合超大 AMA 但不适合社区群主体。**结论：主群用 Community，超大型 AMA 若超 20 万可临时用 AVChatRoom。** 消息速率与在线上限官网未公开细节，需销售确认。

**语音房分档**：
- **500 听众**：三个组合都能直接跑。TRTC 语音聊天室 / LiveKit / Stream Video 均无压力
- **5,000 听众**：需切换到「少数上麦 + 多数纯拉流」模式。TRTC 有直播（CDN/低延迟拉流）档位，LiveKit 需开 ingress/egress 转 HLS，Stream Video 有 livestream 模式。此档起 RTC 成本模型会从「参与者分钟」变成「观众拉流」，单价差异大
- **5 万听众**：不要用 WebRTC 全互通。走「主播 WebRTC 上麦 → 转推 CDN/HLS → 听众拉流」，成本主导项变成 CDN 流量。此档需单独跟销售报价，本报告未覆盖

**自定义 payload**：腾讯 customElem 可携带任意 `data`（二进制/JSON 字符串），另有 `description`/`extension` 字段；单条消息体上限官网未明确公开（一般口径 8KB 量级），**Token 卡片应只放 ticker/合约地址/快照价等标识字段，价格等实时数据在客户端渲染时拉取，不要把完整行情塞进消息体**。Stream 的 `extraData` 同理。这条设计原则对两家都适用，也顺带解决「历史消息里价格过期」的问题。

**自定义身份与匿名**：两家都满足。腾讯 UserSig 由自己服务端用 HMAC-SHA256 签发（含 sdkappid/userId/expire），完全不需要手机邮箱；Stream 用标准 JWT。别名轮换 = 改 nickname，随时可改。**注意 UserID 本身不可变且腾讯限 32 字节**，所以 UserID 必须用与钱包地址无关的随机内部 ID（不要用钱包地址做 UserID，否则匿名承诺失效且无法轮换）。

**中国大陆可用性**：腾讯两边都通，且中国站可直接买海外数据中心套餐，团队在国内开发无障碍。Stream/Sendbird/CometChat 未被墙但无国内节点，国内开发期连接延迟较高（可接受，非阻塞）。产品面向海外用户不涉及国内备案；但若未来要在国内上架，腾讯路线的合规切换成本最低。

**锁定风险**：Stream Pro 及以上、Sendbird Pro 含数据导出功能。腾讯有 Server API 可全量拉取消息（REST 分页导出）。三家的会话/消息数据模型差异不大（channel + message + custom payload），换供应商的主要成本在客户端 UI 层与自定义消息适配层——**建议在客户端与 IM SDK 之间加一层薄的 repository 抽象**（这是本项目唯一值得预先抽象的地方），把 Token 卡片的业务模型与 IM 的 payload 格式解耦。

**E2EE**：腾讯、Stream、Sendbird 均**不提供**开箱 E2EE。20 万人大群做 E2EE 在密码学上本身不现实（sender key 分发开销，参考 XMTP RFC 里 WhatsApp/Signal 约 1,000 人的实际上限）。**建议：大群不做 E2EE，仅对 1:1 私聊考虑客户端自行加密**（用钱包密钥派生，IM 只传密文），代价是私聊消息搜索失效。若 E2EE 是硬需求则只有 Matrix 路线，但与「不写核心代码」冲突。

## 遗留待确认问题（需问销售）

**腾讯云（优先级最高）**
1. 中国站买「海外数据中心」套餐 vs 国际站（tencentcloud.com）签约，两者在功能、节点覆盖、SLA、发票与计费口径（DAU vs MAU）上的确切差异？**按 DAU 计费的中国站路线便宜一个量级，需确认海外用户是否完全支持、有无合规限制**
2. Community 群扩容到 20 万的具体条件（是否必须旗舰/企业版套餐、工单周期、是否额外收费）
3. 20 万人群的**消息速率上限**与**在线成员上限**（官网未公开），以及触发限频后的行为
4. 单条 customElem 的 payload 大小硬上限
5. 消息历史存储时长与各套餐的漫游天数、超期后能否付费延长
6. 2026-04-01 生效的超额 MAU 费率调整具体数值
7. 5,000 / 5 万听众档语音房的推荐架构与报价（TRTC 直播档 vs CDN 转推）

**Stream**
8. 20 万成员单 channel 是否支持完整消息语义：@提及、reaction、回复引用、已读、成员列表分页——Dynamic Partitioning 开启后哪些功能会降级
9. 10 万 DAU（约 30 万 MAU）的 Enterprise 报价，以及并发连接数如何计费（这是隐性大头）
10. 推送通知 add-on 的定价

**通用**
11. AI bot 通过 Server API 高频发消息是否计入 MAU/DAU 与消息量配额，有无 bot 专用计费
12. 语音房录制与回放的存储费用（AMA 场景大概率需要回放）
13. 消息搜索是否包含在基础套餐（Sendbird 需 Pro；腾讯/Stream 需确认）

