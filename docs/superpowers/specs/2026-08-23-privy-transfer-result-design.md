# Privy 同链转账闭环设计（F3–F5 + F11 + F12）

> 日期：2026-08-23  
> 状态：Owner 已批准设计方向；独立规格审查第 4 轮例外复审 `APPROVED`  
> 全局目标：A–I 继续开发，本规格只定义下一可独立验收切片，不表示全项目完成  
> 集成原则：Privy 是交付主干；Stream 与 Hyperliquid 是各自领域的核心供应商；其余能力优先使用维护活跃、许可兼容、可固定版本的 GitHub 开源实现，通过薄适配层接入。不得重复实现钱包、身份、签名、交易构造、广播或供应商状态基础设施。

## 1. 目标

在已完成的 F1/F2/F6/F11 钱包基础上，交付一个诚实、可验证的转账闭环：

1. F3 选择资产；
2. F4 填写并验证收款方；
3. F5 填写金额并展示供应商可证明的费用语义；
4. 复用唯一 F11 Intent 审查与用户授权入口；
5. F12 展示 Privy Wallet Action 的真实生命周期和链上步骤。

HTML 原型继续零网络、零签名，只运行冻结的供应商形状 fixture。生产路径严格使用 Privy Wallet Actions + Flutter 用户授权签名 + BFF 转发。原型不得声称生产 Privy、地址筛查或链上转账已接通。

项目方会在后续注册 Privy、Stream、Hyperliquid 及必要辅助服务账号。在真实凭据到位前，本项目只交付：

- 对官方 API/SDK 精确对齐的 production contract；
- 可替换、冻结、明确标注的 offline fixture；
- 缺凭据时 fail-closed 的配置门禁；
- staging/prod 环境与 secret 注入说明。

账号未注册不是自建替代钱包、IM、Perp、RPC、索引器或签名服务的理由。

## 1.1 全项目 Build-vs-Integrate 规则

能力选择按以下顺序执行：

1. Privy 官方 SDK/API/recipes（身份、embedded wallet、授权、Wallet Actions、政策与状态）；
2. Stream 官方 SDK/API（Chat/Video）与 Hyperliquid 官方 API/SDK（Perp）；
3. 供应商官方推荐的成熟依赖；
4. GitHub 上维护活跃、许可兼容、版本可固定、供应链可验证的开源库；
5. 只有前四层存在已记录的功能缺口、风险/成本分析且获得 owner 明确批准时，才允许自建最小 LOOP-specific 逻辑。

开源依赖必须：固定精确版本与来源、保留 LICENSE、记录 integrity/SHA-256、经薄 adapter 隔离、具备失败降级和升级门禁。不得复制一份开源代码后改成无来源的内部实现，也不得让第三方库越过 Privy/Stream/Hyperliquid 的权威边界。

LOOP 自有代码只承担产品编排、UI、provider-neutral DTO、权限/隐私策略、安全错误映射、路由/生命周期和跨供应商业务规则。

## 2. 绑定产品决定

### 2.1 权威编号不重排

本规格沿用 `文档/页面清单.md`：

- F3 `#send`：选择资产；
- F4 `#send-to`：收款地址、ENS、扫码、最近联系人、风险校验；
- F5 `#send-confirm`：金额、费用语义、预估到账和预审入口；
- F11：现有唯一签名/交易审查弹层，不计 routed screen；
- F12 `#tx-result`：pending / succeeded / rejected / failed、步骤与交易哈希。

加入四个 routed screens 后，`src/screens-order.txt` 和生成 manifest 从 22 变为 26。F11 仍只有一个 surface，不增加 routed screen。

### 2.2 本切片执行范围

- 生产执行：Privy embedded wallet；
- 资产：Privy Transfer API 支持的 named assets，且必须同时存在于 LOOP 的环境 allowlist；
- 路径：same-chain、same-asset、`exact_input`；
- 支持的链和资产由 BFF 配置与 Privy 能力交集决定，客户端不能自行扩充；
- watch-only 始终不能发送；
- connected external wallet 保留现有 F11 语义，但本切片的 F3–F5 生产执行入口显示 provider gap，不伪造 Privy Wallet Action。

这不是全局终态。外部钱包发送、跨链/跨资产传输、F9/F10 Bridge 会在后续 provider-boundary 切片完成。

### 2.3 费用与 gas 文案修正

Privy 的 Transfer API 负责常见转账的交易构造、链状态、广播与 gas payment mode。官方 transfer quote 当前用于 cross-chain/cross-asset（DADC）并仅在这些路径返回 estimated fees / estimated gas；它不能作为本次 same-chain transfer 的虚构 gas 报价来源。

因此 F5：

- 不提供“自定义 gas”控件；
- 不自建 RPC gas oracle 或 raw transaction builder；
- BFF 只投影已验证的 dashboard/config capability：`app_sponsorship_configured`、`wallet_native_required` 或 `provider_managed`；
- sponsorship 已配置但 credits/单笔资格不能被证明时只显示 `App sponsorship is configured; Privy determines eligibility at execution`，不得保证 app 一定支付；
- sponsorship 未配置时显示 `Native gas may be required in this wallet`；
- 供应商没有给出数值时显示 `Exact network fee is unavailable before provider execution`；
- F11 的 `fee_display` 为 `null` 时明确标记 provenance=`unavailable`，不能显示 `≈` 猜测值。

这条取代清单中“网络费（可调）”的旧实现假设，但不改变 F5 的屏幕身份。

### 2.4 F12 能力边界

Privy Wallet Action 的整体状态是权威事实。F12 支持：

- `pending`（同时兼容并规范化供应商 `created`）；
- `succeeded`；
- `rejected`；
- `failed`。

未由官方 Transfer/Action 能力证明前，不展示 accelerate/cancel 按钮。长时间 pending 提供 `Refresh status`、说明与安全返回 Wallet，不把未知结果标成失败，也不自动重复提交。

## 3. 架构

```text
F3/F4/F5 closure-owned draft
  -> LOOP BFF prepare
       - verify Privy session
       - derive user + wallet (never trust client IDs)
       - resolve ENS / validate address
       - call the configured sanctions-screening adapter (Chainalysis target)
       - determine first-recipient evidence
       - re-read wallet/asset balance
       - build exact same-chain Privy transfer request
       - format WalletApiPayload + request expiry + nonce + idempotency key
       - persist opaque bounded review session
  -> versioned CanonicalReviewSource V2 held behind an opaque prepared handle
  -> existing decoder surface with explicit V1/V2 migration
  -> one F11 dialog
  -> Flutter Privy user authorization signature
  -> LOOP BFF revalidate + submit /v1/wallets/{wallet_id}/transfer
  -> Privy returns Wallet Action ID/status
  -> BFF REST polling; verified webhook projection when the project plan enables it
  -> F12 normalized action snapshot
```

### 3.1 组件边界

#### `TransferDraftController`

- 只管理 F3–F5 页面生命周期；
- closure-owned、容量受限、TTL 受限；
- 不把 recipient、amount、wallet ID、review ID 或 action ID 写入 URL、history、sessionStorage、localStorage；
- reload、跨账户、钱包切换或 route proof 失效时销毁草稿；
- 只向 provider adapter 传 raw draft，不自行生成 `LoopReviewIntent`。

#### `PrivyWalletAdapter` 扩展

在现有冻结 adapter 上新增以下 exact capabilities，而不是另建钱包客户端：

- 页面可调用 `prepareTransferReview(request)`：规范化 fixture/BFF prepare 结果，只返回 `Result<{prepared_review_handle}>`；完整 source 保存在 adapter/BFF 的 owner+wallet-bound 有界私有表中；
- 仅由 controller 构造器捕获 `consumePreparedTransferReview({prepared_review_handle, live_binding})`：对私有 registry 做一次原子消费，返回 `Result<{internal_review_id, source: CanonicalReviewSourceV2}>`；该函数不出现在页面 facade、global 或 DOM 上；
- F12 controller 调用 `getTransferResultSnapshot({result_binding_handle})`：由认证 opaque binding 推导 owner/wallet/submission/action，并返回 §4.5 的严格联合 DTO；调用方不得提交 action ID 或 submission record ID。

`PreparedTransferReviewRegistry` 是 adapter 与 controller 在 composition root 共享的 closure-owned abstraction，不是模块全局表。prepare 成功时写入；consume 被调用后无论 success、binding mismatch、expired 或 malformed 都永久删除 handle。成功消费后 immutable source 和 `internal_review_id` 只归 F11 session 所有，handoff 从该 session 取内部 ID；页面永远拿不到 resolver、source 或内部 ID。

`handoffReview` 仍是唯一执行出口。F3/F4/F5 不直接调用 Privy、RPC 或 external wallet。

#### Canonical review / controller migration

现有 F2 demo 与旧 wallet regression 使用 `CanonicalReviewSource V1`。本切片新增 `CanonicalReviewSource V2`，不得把任意 caller object 直接交给 decoder：

- V1 保留现有静态 fixture lookup、exact top-level `amount` precedence、`exact_input`/`exact_output` 和外部钱包回归；
- V2 只由 `consumePreparedTransferReview` 从私有 registry 中的 unguessable handle 原子解析，固定 `exact_input`，包含新的 chain/asset/risk/balance/signature binding；
- `controller.open(review_id, ...)` 继续服务 V1；
- 新增 `controller.openPreparedTransfer({prepared_review_handle, live_context, origin})`，它只消费 adapter 捕获的私有 handle，内部解析 V2，并复用同一 session、history、F11 dialog 与 handoff state machine；生产时钟由 controller/adapter 构造器注入，页面调用方不能覆盖；
- controller 不导出 `openSource`，不接受 canonical-looking object；
- V1 输出 `LoopReviewIntent.version=1`，V2 输出 `version=2`；F11 renderer 只按 versioned exact normalized model 渲染，仍是同一个 surface；
- handle owner、wallet epoch、asset selection、route origin、expiry 或 generation 不匹配即消费并 fail closed。

#### BFF

BFF 是生产 secret、Privy Basic Auth、用户会话验证、地址解析/筛查、idempotency、webhook 与 action binding 的唯一边界。客户端只能提交草稿和用户授权签名，不能指定：

- Privy `wallet_id`；
- owner user ID；
- provider endpoint；
- action ID；
- idempotency key；
- request expiry；
- screening verdict；
- trusted token metadata。

BFF 是薄代理/策略层，不是自研钱包或交易执行器。它必须优先调用 Privy 官方 server SDK/API；序列化、authorization signature 格式、Wallet Action、重试/idempotency 与状态生命周期以 Privy 为权威。可采用 GitHub 开源组件完成通用 HTTP schema、webhook 验签、缓存或可观测性，但这些组件不得构造私钥、签名或链上交易。

收款方能力使用三个独立薄 adapter，并受账号/配置门禁保护：

- `AddressResolutionAdapter` 严格按 `AssetSelection.chain_family` 分流，不能由 recipient 文本猜链：
  - EVM 使用精确版本、MIT 许可、hash 锁定的 `viem getAddress` 做 syntax/checksum/canonicalization；ENS 只在 capability-audited EVM 链上开放，并经研究中已选的 Alchemy RPC + `viem getEnsAddress` 查询。Alchemy 未配置或 credentialed capability audit 未通过时 ENS 返回 unavailable/failed，不回退到自建解析器；
  - Solana 使用 dependency audit 固定版本、许可和 hash 的 Anza 官方开源 `@solana/addresses` `address()` parser。输入必须是 canonical base58、解码为 32 bytes、无前后空白且 round-trip 相同；不得大小写修正。Solana 的 on-curve 与 off-curve/PDA 均可能是协议有效地址，因此不得自写“曲线修复”或一概拒绝 off-curve；是否可作为特定 Privy named-asset destination 由已审计的 Privy capability 决定；
  - ENS 输入在 Solana 上固定返回 `UNSUPPORTED_RECIPIENT_NAME`；EVM 地址不能用于 Solana selection，Solana 地址不能用于 EVM selection；
- `SanctionsScreeningAdapter`：目标供应商是项目调研已指定的 Chainalysis。账号或官方 schema 尚未可用时，不猜测 endpoint、header 或 raw fields，production adapter 必须 disabled 并规范化为 `unavailable`；账号到位后的 capability audit 固定官方 endpoint/schema/version 后才可启用。启用后将经验证的原始响应映射为固定 `clear|blocked|unavailable`，credentials 未配置、timeout、429、5xx、schema 不兼容一律 `unavailable`；
- `RecipientHistoryAdapter`：优先使用 Privy wallet actions/transactions 的完整、同 owner+wallet+chain 出账历史。`seen` 精确定义为同一 user、同一 wallet、同一 source chain 对该 canonical address 至少存在一个 `succeeded` outgoing transfer；完整历史确认无匹配才是 `first_time`；分页未穷尽、partial、provider unavailable 或外部历史缺口均为 `unknown`。

`blocked`、`unavailable`、过期 screening 在 F4、F5、F11 和 POST 前都阻断。`first_time` 需要显式确认；`unknown` 需要独立的“历史不可确认”确认，不能降级成 seen/clear。

实际依赖版本在实施计划的 dependency-audit 任务中从官方 registry/repository 解析并固定；规格不允许实现者临时换成自写 checksum、ENS 或 sanctions 逻辑。

#### 现有 F11

F11 继续负责：canonical decode、source/execution digest、live wallet revalidation、origin/history proof、单次消费、provider handoff、focus/inert/veil 和安全错误。不得新建“Send confirmation”模态层绕过 F11。

#### F12 projector

F12 只消费 BFF 绑定后的 normalized transfer result snapshot。它不读取 F2 transaction history，也不把本地 optimistic 项当成链上事实。

## 4. 数据契约

所有记录使用 exact keys、plain data descriptors、bounded arrays/strings、深冻结结果和十进制字符串。禁止 JS 浮点参与金额、余额、费用或比较。

### 4.1 Raw draft

```text
TransferDraftRequest {
  asset_selection_id: opaque string,
  recipient_input: string,
  amount_decimal: string
}
```

F3 的资产列表不是普通 symbol 数组。adapter/BFF 先签发有界 `AssetSelection` 私有记录：

```text
AssetSelection {
  asset_selection_id: unguessable opaque ID,
  owner_user_id: private binding,
  wallet_id: private binding,
  wallet_epoch: integer,
  chain_family: "evm" | "solana",
  chain_id: canonical LOOP chain,
  provider_chain: Privy chain slug,
  asset_id: LOOP allowlist key,
  provider_asset: Privy named asset,
  token_identity: trusted metadata,
  decimals: integer,
  balance_base_units: canonical integer string,
  balance_fetched_at_ms: server/adapter clock,
  expires_at_ms: server/adapter clock
}
```

同一 symbol 在不同链上必须有不同 opaque ID。客户端不传 user、wallet、chain、decimals、token address、provider asset 或余额权威值；BFF 只从 selection record 推导这些字段。链替换、跨钱包/账户重放、过期或伪造 selection ID 都 fail closed。

生产 draft 不含 `now_ms`。时间只来自 BFF 单调/墙钟策略；offline adapter/test harness 通过构造器注入 deterministic clock，不能从页面 payload 覆盖。

### 4.2 Recipient resolution

```text
RecipientResolution {
  input_kind: "address" | "ens",
  display_input: string,
  resolved_address: canonical address,
  chain_family: "evm" | "solana",
  chain_id: allowlisted chain,
  screening: {
    status: "clear" | "blocked" | "unavailable",
    reason_code: bounded provider-neutral code,
    checked_at_ms: integer
  },
  recipient_history: {
    status: "seen" | "first_time" | "unknown"
  }
}
```

ENS 文本仅供展示，且只允许在 capability-audited EVM 链出现；签名、digest、筛查与提交全部绑定 `chain_family + chain_id + resolved_address`。`screening=blocked|unavailable` 均阻断，且 screening 有固定短 TTL。首次收款方证据不可用时显示 unknown，不猜测，并要求独立确认。

### 4.3 Canonical transfer execution

```text
CanonicalReviewSourceV2 {
  version: 2,
  kind: "transfer",
  execution: PrivyTransferExecution,
  context: TransferReviewContext,
  source_digest: canonical digest,
  expires_at_ms: server time
}

PrivyTransferExecution {
  provider_path: "privy_wallet_action",
  wallet_id: server-derived wallet ID,
  payload: {
    request_id: opaque review ID,
    endpoint_path: "/v1/wallets/{wallet_id}/transfer",
    method: "transfer",
    chain_id: canonical LOOP chain ID,
    provider_chain: allowlisted Privy chain slug,
    asset_id: allowlisted named asset,
    token_address: trusted metadata identity,
    destination: canonical resolved address,
    amount: canonical decimal string,
    amount_type: "exact_input",
    nonce: 24–255 character server-generated nonce,
    gas_payment: "app_sponsorship_configured" | "wallet_native_required" | "provider_managed",
    fee_display: null
  },
  execution_digest: canonical digest
}
```

实际 Privy body 必须由上述绑定字段投影为：

```json
{
  "amount_type": "exact_input",
  "source": {"asset": "<named asset>", "amount": "<decimal>", "chain": "<same chain>"},
  "destination": {"address": "<canonical address>"},
  "nonce": "<server nonce>"
}
```

本切片禁止 destination chain/asset、`slippage_bps`、`fee_configuration` 或 custom token fields，避免静默扩成 Bridge/cross-asset。

`payload.method="transfer"` 是 LOOP semantic method；它不是 HTTP verb。供 Flutter 签名的完整 envelope 必须精确为：

```text
WalletApiPayloadV1 {
  version: 1,
  url: "https://api.privy.io/v1/wallets/{wallet_id}/transfer",
  method: "POST",
  headers: {
    "privy-app-id": configured public app ID,
    "privy-idempotency-key": server-generated bound key,
    "privy-request-expiry": server-generated Unix milliseconds as string
  },
  body: exact Privy transfer body above
}
```

签名 headers 只允许这三个 `privy-*` 字段。Basic Auth、content-type、trace headers、authorization signature 本身不得进入 `WalletApiPayload.headers`。BFF 必须用 Privy 官方 formatter 产生 canonical bytes；Flutter 对同一字节调用官方 `generateAuthorizationSignature`。提交时 URL、POST、三项 signed headers 和 body 必须 byte/semantic-equal，任何差异拒绝。

### 4.4 Review context

Review source 还必须 digest-bind：

- authenticated owner user ID 的私有 binding（不显示、不进 URL）；
- wallet class / wallet identity；
- asset selection ID、wallet epoch、canonical chain 与 provider chain；
- trusted token metadata与 decimals；
- fresh balance snapshot及 fetched time；
- resolved address；
- screening verdict / reason / checked time；
- first-recipient status；
- gas payment mode；
- provider preview state：本次 high-level Privy Transfer 无可绑定 raw transaction 时固定 `unavailable`；
- preview-unavailable acknowledgement 状态（初始 false，不由 provider/caller 预勾选）；
- request expiry；
- origin stack proof。

在 F11 Continue 前，BFF/adapter 重新读取并比较所有 material fields。用户授权签名返回后、真正 POST Privy 前，BFF 必须再次 re-resolve ENS、re-screen canonical address、re-read wallet/balance/config，并与 signed review 深比较。任一变化消费原 review，拒绝 POST 并返回 F5 创建全新 prepare；不能在原 review 上“就地更新”金额、地址、screening、钱包或 body。

项目调研中的 Alchemy Simulate 仍用于未来“已获得 exact raw transaction”的 request kind；Privy high-level Transfer 不暴露可绑定 raw transaction 时，不为满足 UI 自建交易。此时沿用已批准的 F11 `preview_unavailable` 路径：用户必须手动勾选 `I understand that a provider simulation is unavailable` 后才能 Continue。若未来官方能力提供 exact simulation，需新 capability audit，simulation failure 仍走强确认而非自动放行。

### 4.5 Transfer result snapshot

F12 读取一个 exact discriminated union；无 action ID 的未知提交不是伪造的 Wallet Action：

```text
TransferResultSnapshot = WalletActionResult | SubmissionUnknownResult

WalletActionResult {
  kind: "wallet_action",
  wallet_action: WalletActionSnapshot
}

SubmissionUnknownResult {
  kind: "submission_unknown",
  submission_record_id: bounded opaque server ID,
  wallet_id: bound wallet ID,
  created_at_ms: integer,
  signed_request_expires_at_ms: integer,
  safe_message_code: "TRANSFER_RECONCILING",
  action_id: null,
  steps: []
}
```

`submission_record_id` 只用于 normalized snapshot/审计关联，不进入 URL、history、storage 或任一 adapter 调用参数。unknown 分支永远没有 action ID、provider action status、hash 或 explorer link，也永远不能映射为 `failed`。`result_binding_handle` 私下绑定 exact owner + wallet + submission record；一旦找到精确 action ID，BFF 原子地把同一 result binding 投影切换为 `WalletActionResult`，不创建第二条相似金额记录。

`WalletActionSnapshot` 的 exact shape 为：

```text
WalletActionSnapshot {
  action_id: bounded opaque ID,
  review_id: bound opaque ID,
  wallet_id: bound wallet ID,
  type: "transfer",
  status: "pending" | "succeeded" | "rejected" | "failed",
  source_chain: allowlisted chain,
  source_asset: allowlisted named asset,
  source_amount: canonical decimal string,
  destination_address: canonical address,
  destination_amount: canonical decimal string | null,
  created_at_ms: integer,
  failure: {code: bounded code, safe_message: LOOP-owned copy} | null,
  steps: WalletActionStep[]
}

WalletActionStep {
  kind: "evm_transaction" | "evm_user_operation" | "svm_transaction" | "external_transaction" | "tvm_transaction" | "custodian_transaction" | "provider_step",
  status: "queued" | "preparing" | "pending" | "confirmed" | "rejected" | "reverted" | "replaced" | "abandoned" | "failed" | "unknown",
  chain_id: allowlisted chain,
  transaction_hash: canonical hash | null
}
```

Raw provider DTO 和 normalized LOOP DTO 是两个边界。下面只定义经过 capability audit 后实现的投影规则，不允许依据未验证的示例猜测供应商字段：

- REST normalizer 接收官方 `GET /v1/wallets/{wallet_id}/actions/{action_id}?include=steps` transfer shape，把 `id -> action_id`、`status`、`wallet_id`、type-specific fields、raw step `type/caip2/status/transaction_hash` 映射到上表；
- webhook normalizer 只接收官方 `wallet_action.transfer.created|succeeded|rejected|failed` event schemas，把 event type 和官方 action ID 字段映射为同一状态；验签必须使用 Privy 官方 SDK/文档指定的 raw-body verification contract，未完成 credentialed schema/signature audit 时 webhook adapter 不启用；
- raw provider object 允许并忽略未来新增的 data keys，但 required fields、类型、长度、数组容量、plain data descriptors 和已读取字段必须严格；
- exact keys 只要求在 normalized LOOP DTO 上成立；
- 当前已知 raw step type/status 按 Privy lifecycle 精确 allowlist；未知 step type/status 映射为 `provider_step/unknown`、不生成 explorer link，整体 action 状态仍由 Privy top-level status 决定；
- provider `failure_reason` 不直接显示，只映射到固定 LOOP 文案。

事件合并规则：

- duplicate same-state event 幂等；
- `pending -> one terminal` 单向；终态不能回退 pending；
- conflicting terminal events 进入 quarantine，F12 显示 unavailable，并由 REST `include=steps` 人工/自动对账；
- REST 与 webhook 相同终态合并 steps；冲突时不猜测，REST fresh fetch 只用于对账而不是静默覆盖审计记录；
- webhook 可能先于 POST response。BFF 先把已验签事件写入有 TTL/容量的 inbox，key 为 server-known wallet+provider action ID；POST response 持久化 result binding 后再 upsert。同金额/地址绝不能用于自动匹配；
- 如果 POST response 丢失且没有精确 action ID，inbox 事件保持 unbound，submission 保持 unknown；
- 未开通 Privy Enterprise webhooks 时，polling 是 production 主路径；开通并验证 webhook 后 webhook 为实时投影、低频 polling 为对账。

Mismatched wallet/review/result binding、excessive steps、accessor/prototype pollution、invalid timestamps/hashes 或 unsafe provider text cause fail-closed `MALFORMED_PROVIDER_RESPONSE`。Unknown raw keys 本身不构成失败。

## 5. 页面与状态

### 5.1 F3 `#send`

显示可发送的 named assets、链、可用余额和 provider provenance。

状态：loading、ready、zero balance、partial provider data、provider unavailable、unsupported wallet、unauthenticated。只有 `privy_embedded + supported asset + positive balance` 可继续。

### 5.2 F4 `#send-to`

输入方式：地址、扫码、最近联系人；ENS 只在当前 selection 属于 capability-audited EVM 链时显示。Solana selection 不渲染 ENS suggestion，粘贴 ENS 固定显示 unsupported。HTML 原型使用明确 fixture，扫码不启动真实相机。

状态：idle、validating、resolved clear、invalid、ENS failed、screening blocked、screening unavailable、first time、history unknown。高风险/制裁结果是事实陈述，不显示“AI score”。

`blocked`、`unavailable` 或过期 screening 都无继续按钮；`first_time` 必须在进入 F5 前显式确认；`unknown` 显示无法确认是否首次，并要求独立确认。任一确认只绑定当前 resolved address + chain + wallet epoch，地址变化即清除。

### 5.3 F5 `#send-confirm`

显示：发送资产、canonical amount、完整/可复制收款地址、链、到账语义、gas payment mode、筛查事实和首次收款方状态。

状态：ready、amount invalid、zero、over balance、balance stale、native gas reserve unknown、provider unavailable、screening unavailable/expired、preview unavailable、review preparing、review prepare failed。

不提供 `Max`，除非供应商能证明 gas sponsorship 或可用余额已扣除必要 reserve。sponsorship credits/资格不确定时不得用“app pays”绕过 native reserve 测试。Continue 只创建/打开 F11 review，不直接执行。

F5 显示 `Provider simulation unavailable for this high-level Privy transfer`，但 acknowledgement 只在 F11 内完成；F5 不伪造模拟结果，也不预勾选 F11 acknowledgement。

### 5.4 F11

Transfer 摘要使用供应商绑定字段；地址只在摘要缩写，但详情必须可查看/复制完整地址。`fee_display=null` 显示 `Exact network fee unavailable before provider execution`。`provider_preview=unavailable` 时沿用已批准的 secondary confirmation：unchecked acknowledgement + 风险说明；未勾选时 Continue disabled。若出现 provider simulation failure，使用固定强警告和独立确认，不把它改写成 success。

Continue 后：

1. 重新验证 live user/wallet/balance/recipient/screening/expiry；
2. Flutter 签署 BFF 格式化的 `WalletApiPayload`；
3. BFF 校验 payload bytes、signature、expiry、nonce、idempotency 与 review binding；
4. 签名返回后再次 resolve/screen/read balance，并深比较 signed body；
5. 在任何 transport byte 可能写出前，事务性持久化 write-ahead `SubmissionAttempt` 并取得 wallet-scoped send lock；
6. recovery lease owner 才能提交 Privy transfer；
7. 只接受严格 normalized response，并先持久化 exact action response 再原子绑定 result；
8. 创建/更新私有 result binding 并导航 F12。

用户拒绝保持 `provider_rejected`；同步网络失败不是 action failed。Privy 没有“按 idempotency key 查询”的 API，因此不确定提交使用以下精确状态机：

```text
SubmissionAttempt {
  submission_record_id: bounded opaque server ID,
  owner_user_id: private binding,
  wallet_id: private binding,
  internal_review_id: private binding,
  signed_request_digest: canonical digest,
  idempotency_key: encrypted/private bound value,
  request_expiry_ms: integer,
  replay_material: encrypted-at-rest exact URL/method/signed headers/body/authorization signature,
  state: "committed_before_write" | "transport_in_progress" | "submission_unknown" | "response_recorded" | "action_bound" | "proved_not_submitted" | "operator_closed",
  provider_action_id: bounded opaque ID | null,
  recovery_lease: bounded owner + expiry + fencing token,
  created_at_ms: integer,
  updated_at_ms: integer
}
```

创建 attempt 与取得唯一锁 `owner_user_id + wallet_id` 必须在同一个 durable transaction 中完成；唯一约束使两个并发签名至多一个进入 `committed_before_write`。transaction commit 成功前，HTTP client 不得取得请求材料或打开 provider socket。replay material 是 server secret，只能由带 CAS/fencing token 的 recovery worker 读取，绝不返回 Flutter/HTML、日志或 telemetry。

| cut point | 状态与允许动作 |
|---|---|
| signature 未到 BFF / BFF validation 前失败 | `not_submitted`；原 review 消费，允许用户回 F5 创建全新 review |
| write-ahead transaction/lock commit 失败 | transport 尚不可调用；`not_submitted`，无 attempt、无 provider 请求，允许新 review |
| attempt 已 commit，但 transport 能以可审计 primitive 证明零字节写出 | CAS 为 `proved_not_submitted` 后才释放锁；原 review 消费，允许新 review |
| attempt 已 commit，无法证明零字节写出、POST 已写出、timeout 或进程在 write 周边崩溃 | 保持/恢复 `submission_unknown` 与同一锁；BFF 只可在原 signed expiry 内以 replay material 做相同 URL/body/headers/authorization signature/idempotency key exact replay；禁止新 key/新 review |
| Privy 明确同步 5xx | 先 durable 记录 response；Privy 文档说明 idempotency record 被删除，recovery worker 可在原 signed expiry 内进行一次受控 exact same-key replay，但仍不得换 body/key；再次不确定则 durable unknown |
| response 含 action ID | 先把 exact response/action ID CAS 到 `response_recorded`，再在同一 durable transaction 创建/更新 result binding、转为 `action_bound` 并释放 unknown send lock；之后只按 wallet+action GET `include=steps` 或已绑定 webhook 更新 |
| response 已收到但在记录/binding 前进程崩溃 | 因 attempt 与锁已先存在，重启保持 unknown；expiry 内 exact replay 获取同一 idempotent response，或由已验签 exact event 绑定，绝不解锁创建新转账 |
| signed expiry 已过且仍无 action ID | durable `submission_unknown`；F12/Wallet 显示人工对账状态并保持 wallet-scoped send lock，直到 BFF 通过精确 action ID/event 解决，或 operator 在保存 provider 对账证据和审计理由后明确关闭 |

每次进程启动和定时 recovery 都扫描非终态 attempt。worker 必须用 compare-and-swap 获取短 TTL lease 与递增 fencing token；旧 lease 即使随后恢复也不能写状态或再次发送。恢复结果只能是：在 signed expiry 内执行一次受控 exact replay、从已持久化 exact action response/event 原子完成 binding，或保持 `submission_unknown`。任何 crash/restart 都不能删除 attempt、释放锁或推导 `not_submitted`。

`submission_unknown` 不是 Privy action `failed`，不改余额、不显示“重试转账”。锁的 exact key 是 authenticated `owner_user_id + Privy wallet_id`，范围是该钱包的所有新 outgoing transfer，不是“相同金额/地址/draft”：

- Wallet、F2 asset detail、F3、其他 Send CTA 和 `#send` direct link 都先查询该锁；存在时统一导向当前 F12 reconciliation，不能创建 asset selection、draft、review、nonce 或新 idempotency key；
- 锁建立时消费该钱包尚未提交的 prepared transfer handles，并使旧 send route generations 失效；收款、只读余额和非 transfer 产品能力不受影响；
- 只有精确 action ID 被同一 submission record 绑定（此时转为正常 action tracking）或带脱敏证据的 operator reconciliation 才能解除；TTL、页面关闭、logout、换地址/资产/链、相似交易或 signed expiry 都不能自动解除；
- BFF 可以列出 wallet actions 辅助人工调查，但金额、地址、时间相似不能自动绑定或解锁。

### 5.5 F12 `#tx-result`

- pending：进度、创建时间、已知 steps、Refresh status；不改余额；
- submission unknown：说明请求可能已到 Privy、正在安全对账；无 retry/new transfer；
- succeeded：成功文案、最终 destination amount（若供应商提供）、steps 与 allowlisted explorer links；只有这一状态可触发后续余额/历史刷新；
- rejected：说明未执行任何步骤，可返回 F5 创建全新 review；
- failed：说明某一步失败且可能已有链上影响，展示已知 steps；不提供盲重试；
- malformed/unavailable：安全错误和返回 Wallet；
- direct deep-link/reload without authenticated result binding：`This transfer result is no longer available. Return to Wallet.`

Explorer URL 由 `chain_id -> fixed base URL` allowlist + canonical hash 构造，绝不直接渲染 provider URL。

## 6. History、生命周期与隐私

- 路由为 `#send`、`#send-to`、`#send-confirm`、`#tx-result`，hash 不带参数；
- canonical stacks 为：Wallet `['scr-wallet']`；F3 `['scr-wallet','scr-send']`；F4 `['scr-wallet','scr-send','scr-send-to']`；F5 `['scr-wallet','scr-send','scr-send-to','scr-send-confirm']`；F12 `['scr-wallet','scr-tx-result']`；
- Wallet -> F3、F3 -> F4、F4 -> F5 使用 push；F11 继续使用现有 marker lifecycle，不改变 routed hash；收到 action ID 或进入 submission_unknown 后，以 replace 把 F5 改为 F12 并使全部 send draft markers/generation 失效；
- F12 的 in-app Back replace 到 Wallet。浏览器 Back 若落到历史 F4/F3，stale generation 必须立即 sanitize/replace 到 Wallet，不能恢复可重提的 draft；浏览器 Forward 到 stale F12 marker 同样重新验证 result binding，无 binding 则 Wallet；
- 每次 forward navigation 写入闭包私有 marker 与最小 `history.state` proof；state 不含业务 payload；
- Back/Forward/BFCache 必须验证 exact route ancestry、account/wallet epoch 和 controller generation；
- F11 返回仍沿用现有 `returning_to_origin -> handoff_pending -> provider_*` 状态机；
- F12 result binding 与 review binding 分离、容量受限、TTL 受限、one-time origin handoff；`getTransferResultSnapshot` 只接收 opaque `result_binding_handle`，BFF 由它推导 owner+wallet+submission/action；durable unknown record 与 wallet send lock 不随页面 binding TTL 自动删除；
- HTML fixture 的 result handle 只在 closure 内，reload 后诚实 unavailable。生产 BFF 在 authenticated server session 中保存当前 device-flow result cursor；reload 的 `#tx-result` 可无 action ID 地恢复该 result binding。多个并发 flow 不自动选“最近金额相似”的 action；无唯一 cursor 时 unavailable；
- logout、user switch、wallet switch、pagehide/BFCache restore mismatch 清理客户端草稿/review/result handles；服务端 durable submission record 与 wallet send lock 不因此删除，原 owner/wallet 再认证后仍需对账；
- URL、DOM attributes、console、toast、storage、clipboard 和错误文案不得泄露 app secret、authorization signature、Privy JWT、nonce、idempotency key、完整 provider payload或内部 user ID。

## 7. 供应商与原型边界

### 7.1 HTML fixture

`SimulatedPrivyWalletAdapter`：

- 只使用公开、冻结、可审计 fixture；
- 无 `fetch`/XHR/WebSocket；
- 无 secret、JWT、签名、私钥、seed；
- 不构造真实交易；
- 支持 deterministic pending/succeeded/rejected/failed/malformed/unavailable 场景；
- completed fixture 必须 trusted-click、closure-ephemeral、reload reset，不能通过 URL/storage 激活。

### 7.2 生产 Flutter/BFF

- Flutter 使用 Privy 官方 SDK 生成 user authorization signature；
- BFF 使用 Privy 官方 server SDK/REST 格式与转发，不手写签名算法；
- app secret 只在 secret manager/BFF；
- authorization signature 覆盖 exact URL/method/Privy headers/body，包括 idempotency/expiry；
- webhook 验签、幂等、action ownership 和事件顺序在 BFF 处理；
- polling 低频、终态停止；
- staging/prod 使用独立 Privy app/config/policies/webhook secret。

真实 Privy 账号/凭据未提供时：

- production adapter 保持不可启用；
- 构建与测试不要求 secret；
- 启动生产模式必须因缺配置而 fail closed，并指出缺少哪一类配置但不输出 secret 名值；
- fixture 模式必须持续显示 `Simulated Privy — no network, no signing`；
- fixture 通过不能替代账号注册后的 staging integration test。

## 8. 错误语义

至少覆盖：

- `UNAUTHENTICATED`
- `UNSUPPORTED_WALLET`
- `PROVIDER_GAP`
- `INVALID_ASSET`
- `ASSET_SELECTION_INVALID`
- `SOURCE_CHAIN_MISMATCH`
- `INVALID_RECIPIENT`
- `ENS_RESOLUTION_FAILED`
- `UNSUPPORTED_RECIPIENT_NAME`
- `ADDRESS_BLOCKED`
- `SCREENING_UNAVAILABLE`
- `SCREENING_EXPIRED`
- `FIRST_RECIPIENT_ACK_REQUIRED`
- `HISTORY_UNKNOWN_ACK_REQUIRED`
- `INVALID_AMOUNT`
- `INSUFFICIENT_BALANCE`
- `BALANCE_STALE`
- `REVIEW_EXPIRED`
- `LIVE_CONTEXT_MISMATCH`
- `USER_REJECTED`
- `POLICY_REJECTED`
- `ACTION_PENDING`
- `SUBMISSION_UNKNOWN`
- `ACTION_FAILED`
- `MALFORMED_PROVIDER_RESPONSE`
- `PROVIDER_UNAVAILABLE`

所有用户文案由 LOOP 固定映射。retryable 只在明确安全的 pre-submit/read 路径为 true；提交后 unknown/failed 不能自动 retry。

## 9. 无障碍与响应式

- 375×667 和桌面无横向溢出；
- 所有按钮/输入/列表行至少 44×44 CSS px；
- 每屏唯一可见 H1；
- loading/status 使用正确 `aria-live`，错误聚焦到摘要或字段；
- F11 继续满足 dialog、focus trap、inert、Escape/Cancel、reduced motion；
- 地址不能只靠颜色/缩写辨识；
- F12 状态必须同时用文本和图标；
- 页面切换/BFCache/返回后焦点回到有意义的触发控件。

## 10. TDD 与验收

### 10.1 RED 先行

新增 focused transfer verifier，先证明以下全部失败：

- 26-screen manifest/build expectations；
- F3/F4/F5/F12 routes、direct links、Back/Forward/reload；
- exact adapter capabilities/DTO keys/deep freeze；page facade exposes prepare only, controller-captured consume is not reachable from page/global/DOM, and result lookup accepts only a result binding；
- asset-selection handle binds exact owner/wallet epoch/symbol/source chain/provider chain；same-symbol multi-chain substitution, forged/expired/replayed handle all fail；
- V1 legacy static transfer keeps top-level-amount precedence and exact-output regressions；V2 dynamic prepared handle cannot accept caller source object, cross-owner/wallet/origin/generation injection fails；consume is atomic and success/mismatch/expired/malformed handles all fail on second use while internal review ID remains controller-only；
- fixed-point amount/decimals/over-balance/native reserve uses an independent integer/string oracle and adversarial 0/leading zero/max precision/100-char vectors；
- address/ENS/screening/first-recipient matrix includes invalid EVM checksum, ENS changes, EVM↔Solana substitution, Solana malformed/non-canonical/base58/decoded-length/on-curve/off-curve vectors, ENS-on-Solana rejection, Chainalysis blocked/unavailable/429/5xx/malformed/expired, fully-seen/first/partial-unknown histories and acknowledgement reset；
- no business payload in URL/history/storage；
- dynamic review source and F11 V1/V2 binding；preview unavailable acknowledgement is unchecked, required, reset on material change, and simulation-failure copy remains strong；
- exact official formatter golden bytes for full `WalletApiPayload` URL/POST/three signed headers/body；forbid Basic/content-type/trace/signature headers；Flutter signature fixture must cover byte equality；
- authorization/idempotency/expiry/TOCTOU cut points: pre-send failure, transactional attempt+lock commit-before-any-write, explicit proved-zero-byte unlock, write-after-commit timeout, kill/restart before write/during write/after response-before-record/after record-before-binding, exact same-key replay, explicit synchronous 5xx, second timeout, expiry before resolution, action-ID response, post-sign ENS/screening/balance/config changes；
- concurrent recovery workers prove one active lease/fencing token by CAS；stale worker, lease expiry, duplicate response/event and process restart cannot double-send, regress state or release the wallet lock；
- action four-state + submission_unknown + steps + explorer allowlist；REST `id`/webhook action ID mapping, webhook-before-binding inbox, duplicate/out-of-order/terminal-conflict, REST/webhook reconciliation and unknown raw keys；
- result-binding handle ownership/TTL/capacity/reload/current-flow cursor；caller action/submission ID, similar-amount auto-match and stale route markers fail；unknown submission creates the exact owner+wallet send lock and every Wallet/F2/F3/direct-link transfer entry remains blocked until exact reconciliation；
- sponsorship-configured-but-ineligible/credit-exhausted and wallet-native-required paths never guarantee free gas or enable unsafe Max；
- pending/rejected/failed balance invariants；
- malicious provider shapes/prototypes/accessors/arrays/strings；
- mobile/a11y/focus/inert/BFCache；
- zero-network/zero-signing prototype boundary；
- production source scans prohibiting custom transaction/gas/signature infrastructure。

### 10.2 两级完成门

HTML fixture gate 和 credentialed production gate 分开记录：

1. **Prototype gate**：26 屏、全部 fixture/state/security/a11y/determinism 回归通过，只能声明 `Simulated Privy — no network, no signing`。
2. **Staging R0 gate（账号到位后）**：
   - 官方 Privy Flutter + server formatter 产生的 payload/signature 在 staging 成功执行；
   - server 与独立 test oracle 对 amount/base-units/decimals 做 golden vector；
   - Alchemy/Chainalysis/ENS adapters 使用 staging credentials 通过 allowlisted network 与 failure injection；
   - Privy test wallet 完成 same-chain named-asset transfer，轮询/可用 webhook 收到同一 action，步骤/hash 与 explorer 对账；
   - 每个 uncertain-submit cut point 在受控 proxy 中证明至多一次；
   - balance/history 仅在 `succeeded` 刷新并与 provider/testnet 复算一致。

没有 staging credentials 时这些测试明确 `NOT RUN — CREDENTIALS REQUIRED`，不能以 skip/fixture green 记为生产通过。全局 A–I 最终完成必须补齐该门。

### 10.3 回归

每个实现任务都运行：

- new transfer focused suite；
- existing wallet foundation focused suite；
- account suite；
- shared suite；
- docs suite；
- Python/JavaScript syntax；
- AST/security gates；
- deterministic `app.html` / `docs.html` builds。

### 10.4 独立审查

每个任务使用 fresh implementer，随后独立 specification reviewer 和独立 quality reviewer。所有 Medium+ 修复并由同一 reviewer 复审通过后才能进入下一任务。最终根代理重新运行完整链，不复用子代理结论。

## 11. Definition of Done

本切片有两个不可混称的完成状态：

- `prototype_complete`：仅表示 HTML fixture gate、静态 contract、测试与审查完成；对外必须保留 `Simulated Privy — no network, no signing`，不得称 production integration complete；
- `production_integration_complete`：只有账号/凭据到位且 10.2 的 credentialed staging R0 全部真实执行通过后才能声明。`NOT RUN — CREDENTIALS REQUIRED` 不算通过。

声明 `prototype_complete` 需要同时证明：

1. F3/F4/F5/F12 四屏与 F11 单一 surface 完整；
2. 26-screen deterministic build；
3. HTML fixture 零网络、零签名、无 secret；
4. 生产 contract 明确对应 Privy Transfer、authorization signatures、Wallet Action status/webhooks；
5. 地址筛查、首次转账、固定点金额、TOCTOU、idempotency 和 action binding fail closed；
6. 四态 F12 与 balance/history invariants 通过；
7. 所有 focused/regression/docs/syntax/security/determinism checks 通过；
8. 独立规格与质量审查无遗留问题；
9. 文档只声明本切片的准确完成级别，Stream、Hyperliquid 和剩余 A–I 继续 pending/in progress；
10. 新增依赖全部遵守官方优先/GitHub OSS 次级的版本、许可、hash、adapter 和升级门禁；没有为缺账号而建立替代供应商基础设施。

声明 `production_integration_complete` 还必须完成 staging R0 的全部六项实测并保存脱敏证据。全局 A–I 目标在 Privy、Stream、Hyperliquid 及被选辅助供应商各自所需的 credentialed gate 未执行前不能标记完成；账号稍后注册只会使该状态保持 pending，不会授权项目自建替代服务。

## 12. 官方依据

- Privy Wallet Actions overview: https://docs.privy.io/wallets/actions/overview
- Privy Transfer API: https://docs.privy.io/api-reference/wallets/transfer
- Privy transfer quote: https://docs.privy.io/api-reference/wallets/transfer/quote
- Privy authorization signatures: https://docs.privy.io/api-reference/authorization-signatures
- Privy signing utility functions / Flutter WalletApiPayload: https://docs.privy.io/controls/authorization-keys/using-owners/sign/utility-functions
- Privy Wallet Action status: https://docs.privy.io/wallets/actions/status
- Privy Wallet Action webhooks: https://docs.privy.io/wallets/actions/webhooks
- viem `getEnsAddress`: https://viem.sh/docs/ens/actions/getEnsAddress
- viem `getAddress`: https://viem.sh/docs/utilities/getAddress
- Alchemy viem setup: https://www.alchemy.com/docs/set-up-alchemy-with-viem
- Alchemy Ethereum API quickstart: https://www.alchemy.com/docs/reference/ethereum-api-quickstart
- Anza `@solana/kit` / `@solana/addresses`: https://github.com/anza-xyz/kit

Chainalysis 在本规格中是经项目调研选定、但等待账号/官方 contract audit 的目标适配器。由于当前未获得可验证的项目凭据与固定 API schema，本规格有意不引用或发明 endpoint；启用 production adapter 前必须把届时的官方依据、schema 版本和失败注入结果加入 dependency/capability audit。

## 13. Repository checkpoint

仓库没有 Git 元数据，因此不能执行本技能通常要求的 commit。规格文件本身、`task_plan.md`、`progress.md` 与独立审查记录共同作为检查点；不得初始化 Git。
