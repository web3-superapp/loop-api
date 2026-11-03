# 决策 0197：内置 DApp 浏览器的服务端签名出口与只读通道——`dapp_tx` / `dapp_sign` intent、风险标记、`rpc-read` 代理、开关默认关（S342-api，主代理决策 0270）

- 状态：已采纳（S342-api）；开关 `DAPP_BROWSER_ENABLED` 默认 `off`
- 日期：2026-11-03
- 基线：`4355097`（integration/v2）
- 依据：`LOOP/docs/55-内置DApp浏览器-2026-11-03.md` §一、§二；`docs/00-主代理规则.md` 规则 3（统一签名出口）、规则 8（BSC Mainnet 签名与广播关闭）；决策 0035（统一 intent）、0038 / 0077 / 0194（launch slot 链规则、opt-in 列表）、0065（金丝雀）。

## 1. 范围

App 自建的 DApp 浏览器（S342-mobile）把页面发来的 `eth_sendTransaction` / `personal_sign` / `eth_signTypedData_v4` 先送服务端准备 intent，用现有确认页 + Privy 签名；读方法走服务端只读代理。服务端只做三件事：准备不可变 intent（预执行、解码、风险标记）、记录签名回报、转发白名单读请求。

不做：`eth_sign`（裸 hash）、`eth_signTransaction`、合约部署（无 `to`）、批量 / `wallet_sendCalls`、ERC-1155 解码、SIWE 域名比对、外部合约名单 / 安全评分。

## 2. 实体与稳定 ID

| 实体                        | 主键 / 标识                | 说明                                                                                                                                                                                                    |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet_intents`（新 kind） | `intent_id` uuid（opaque） | `kind = 'dapp_tx'`（launch slot 测试网上的交易）/ `'dapp_sign'`（消息签名）；payload / review 列沿用 000021 冻结触发器                                                                                  |
| `wallet_intent_events`      | 追加式                     | `dapp_sign` 回报：`signature_reported` / `late_signature_report`，`details = { signatureSha256 }`；拒绝：`signature_report_rejected` + `SIGNATURE_MISMATCH`                                             |
| `provider_operations`       | 幂等日志                   | `operation_kind = wallet_intent_dapp_tx / wallet_intent_dapp_sign`、`domain = bsc`、scope `wallet_intent_prepare`；请求摘要 = wallet + chain + origin + to/data/value（或 method + payload 的 SHA-256） |
| 站点 origin                 | 字符串快照                 | 只作 review 字段与幂等摘要输入，不作任何主键 / 关联键                                                                                                                                                   |
| LOOP 已知合约               | 无新表                     | 由配置（LoopRouter / 官方池 router / router registry / launch2 Factory / Launch v1 合约 / USD1）+ `launch2_instances` 的 11 个合约列 + Asset Registry `verified` 资产即时判定；地址只作查找条件         |

迁移 `000107_wallet_intent_dapp_kinds`：只放宽 `wallet_intents_kind_check`（加 `dapp_tx`、`dapp_sign`），`down` 在存在 DApp intent 时拒绝。无新表、无新列——签名摘要放在事件 `details`。`launch2_instances` 按任一合约地址反查（新仓库方法 `getInstanceByContractAddress`）不建索引：表很小，且只在 DApp 交易准备时查一次。

## 3. 接口

全部：Privy Bearer 逐请求校验 + `X-Loop-Contract-Version: 2.0`；三个写接口带 `Idempotency-Key` UUIDv4；`rpc-read` 是不落状态的 POST，带键即 400（同 `swap/quote`）。

### 3.1 `POST /v2/wallet-intents/dapp-tx`（kind `dapp_tx`）

请求 `{ walletId, chainId, origin, tx: { to, data?, value? } }`：`data` 0x 偶数位 hex ≤ 10,000 字节（缺省 `0x`）；`value` JSON-RPC hex quantity（缺省 `0x0`）；`tx` 其他键（`gas`、`nonce`、`from`…）400——gas / 费用 / nonce 由服务端绑定。

服务端：读原生余额（head 快照）→ `getCode(to)` + 已知合约目录 → approve / transferFrom 选择器时对 `to` 做 ERC-165 `supportsInterface(0x80ac58cd)` 探测 → 解码 → 对解码出的 counterparty 同样 `getCode` + 目录 → 金丝雀对手名单（`to` 与 counterparty，名单非空时）→ `eth_call` + `estimateGas`（合约调用 gas ×1.2；对 EOA 的纯转账 21,000）→ 费用快照 → `value + maxFee ≤ 原生余额` 否则 409 `INSUFFICIENT_BALANCE` → pending nonce → `expiresAt = +120 s` → `sealIntent`。

响应：`walletIntentResource`（201 新建 / 200 幂等重放）。

- `review.asset = { assetId: "eip155:97:native", address: null, symbol: "tBNB", decimals: 18 }`，`review.amount` = value；`recipient / spender / decodedCall`（顶层）= `null`——DApp 的解码放在 `review.dapp`，顶层 `decodedCall` 的封闭枚举保持不变。
- `review.dapp = { origin, method: "eth_sendTransaction", to, value, decodedCall, counterparty, message: null, typedData: null, riskFlags }`：
  - `to` / `counterparty`：`{ address, checksumAddress, isContract, isVerified, knownContract: { kind, role, label } | null }`，counterparty 另有 `role: spender | operator | recipient`。
  - `decodedCall = { functionName | null, selector | null, standard: erc20 | erc721 | permit2 | loop | null, args: Record<string,string>, dataLength }`。所有目标都按选择器解码 ERC-20 `transfer / approve / increaseAllowance / transferFrom`、ERC-721 `approve / transferFrom / safeTransferFrom(3 参与 4 参) / setApprovalForAll`、Permit2 `approve`（仅 Permit2 规范地址）；LOOP 方法（LoopRouter、官方池 router、launch2 Factory / curve / NFT / hook / escrow / meme、router registry、Launch v1）**只在目标是 LOOP 已知合约时**按 ABI 解码，避免外部合约撞选择器被冠以 LOOP 名称；其余 `functionName: null` + `selector` + `dataLength`；无 calldata 时 `selector: null`。
  - `riskFlags`（固定顺序，只在条件成立时出现）：`UNLIMITED_APPROVAL`（ERC-20 approve / increaseAllowance、Permit2 approve 金额 ≥ 2^128）、`APPROVAL_FOR_ALL`（`setApprovalForAll(op, true)`）、`UNVERIFIED_CONTRACT`（`to` 或 counterparty 是合约且不在 LOOP 目录）、`SIMULATION_FAILED`（预执行未通过）。
- `policy`：`exposureBasis = none`、`valueUsd = null`（测试网原生币无价，不计每日金丝雀额度；主网不开放，USD 上限无意义）。
- `signing.mode = device_eth_send_transaction`；之后沿用 send 生命周期：Privy `eth_sendTransaction` → `broadcast-report` → `wallet-intent-reconcile`（`chainId` = slot 的 intent 走 slot client）。

**预执行失败的处理（写明）**：`eth_call` revert、`estimateGas` 不可用、或 RPC 调用异常（非链不可达）都**不拒绝创建**——intent 以 `prepared` 落库，`signing.allowed = false`，`signing.reasonCode` = `BSC_CALL_REVERTED` / `GAS_ESTIMATE_UNAVAILABLE` / `SIMULATION_UNAVAILABLE`，`riskFlags` 含 `SIMULATION_FAILED`。与现有 send 的 “gas 估算不可用” 同一规则（`intentStateForSimulation`）；send_nft 的 409 是 NFT 专属（已知 owner 后 revert 只能是对方拒收），DApp 不沿用。App 据此告诉页面失败原因（EIP-1193 错误），不弹签名。

### 3.2 `POST /v2/wallet-intents/dapp-sign`（kind `dapp_sign`）

请求 `{ walletId, chainId, origin, method: "personal_sign" | "eth_signTypedData_v4", payload }`：personal_sign 的 `payload` = 页面传来的 message 原样（0x hex = 原始字节，否则 UTF-8 文本；≤ 16,384 字节）；typed data 的 `payload` = 页面传来的 JSON 字符串（≤ 32,768 字符）。

- personal_sign：`review.dapp.message = { encoding: utf8 | hex, text | null, hex, byteLength }`——字节是可打印 UTF-8（严格解码、无 \t\n\r 以外控制字符）时 `utf8` + 原文，否则 `hex`。
- typed data：按 EIP-712 解析并用 viem `hashTypedData` 校验可哈希（整数接受 number / 十进制 / 0x 字符串，地址统一小写；未知类型、字段缺失、domain 多余键 → 422 `TYPED_DATA_INVALID`）；`review.dapp.typedData = { primaryType, domain: { name, version, chainId, verifyingContract, salt }, fields: [{ path, type, value, truncated }], fieldsTruncated }`——消息树按类型顺序展平为叶子（≤ 256 个，单值 ≤ 1,024 字符，超出标 `truncated` / `fieldsTruncated`；待签原文完整在 `signatureRequest`）。
- `domain.chainId` 存在且 ≠ 请求链 → 422 `TYPED_DATA_CHAIN_MISMATCH`；不带 `chainId` 的 typed data 放行（无链绑定，例如部分登录消息）。
- `riskFlags`：`PERMIT_SIGNATURE`（primaryType 为 `Permit…`、Permit2 的 6 种 primaryType、domain.name = `Permit2` 或 verifyingContract = Permit2）；Permit 再带 `value / amount ≥ 2^128` 或 DAI 式 `allowed = true` → 加 `UNLIMITED_APPROVAL`。
- 资源新增顶层 `signatureRequest = { method, params }`（**只在 `dapp_sign` 上出现**）：personal_sign `[message, address]`，typed data `[address, typedDataJson]`——设备原样交给 Privy embedded provider；它在 canonical payload 内，进入 `reviewSha256`。
- `simulation = { status: unavailable, source: not_applicable, reasonCode: SIGNATURE_NOT_SIMULATED }`，但 intent 直接 `awaiting_signature`、`signing.allowed = true`（消息签名无可预执行的东西）；`signing.mode = device_personal_sign / device_sign_typed_data_v4`；`fee = null`、`unsignedTransaction = null`、`amount = 0`，`balance` 为 slot 原生余额快照（取 head 事实）。

### 3.3 签名回报：新增 `POST /v2/wallet-intents/{intentId}/signature-report`

评估：`broadcast-report` 的语义是 “交易哈希 + 链上比对 + 对账 lane”，签名没有链上可观测物，复用会让对账 lane 与 `transactionMatchesPayload` 出现无意义分支，故新增端点。

- 请求 `{ signature }`（65 字节 hex）。服务端对 `signatureRequest` 做 ecrecover（Privy 内置钱包是 EOA；personal_sign 用 EIP-191，typed data 用 EIP-712），签名者 ≠ intent 钱包 → 422 / `SIGNATURE_MISMATCH` 并写 `signature_report_rejected` 事件。
- 匹配 → `awaiting_signature → confirmed`（事件 `signature_reported`）；intent 已过期 / 被新 prepare 顶替 / 已取消时仍记录（`late_signature_report`，与迟到的 broadcast-report 同口径——签名已经存在，记录的是事实）；已 `confirmed` 时重报幂等返回。其他 kind → 422 `VALIDATION_FAILED`。
- **存储**：只存签名的 SHA-256（事件 `details.signatureSha256`），**不存签名原文**——Permit 类签名本身就是可提交的授权凭证，落库即扩大泄露面；审计只需要能对上 “这次签名是哪一份”。消息 / typed data 原文本来就在冻结的 canonical payload 里（页面提供、非秘密）。
- 不受 `DAPP_BROWSER_ENABLED` 管：开关只关新的入口；一个已签出的签名仍应能记账。

### 3.4 只读通道：选 `POST /v2/chain/rpc-read` 服务端代理

评估：

- “App 直接用 Privy provider 读”：Privy Flutter SDK 的 `EmbeddedEthereumWalletProvider.request` 面向签名方法（11-02 已确认 SDK 不带浏览器），读方法是否转发、转发到哪个 RPC、BSC 测试网是否有 RPC 都不受我们控制，且无法在本机验证；配 RPC URL 进 App 又会把节点凭据带进客户端。
- 服务端代理：走 API 已有、已做链 ID 校验的 RPC client（主网 `BSC_RPC_URLS`、slot `LAUNCH_BSC_RPC_URLS`），凭据不出服务器；方法白名单与参数校验可测；代价是 RPC 额度（NodeReal 月额度历史上用尽过）——用按账户限流 + `eth_chainId` 本地应答 + getLogs 跨度上限控制。

选代理。规则：

- 链：只 `eip155:56` 与 launch slot 链（其他 422 `CHAIN_MISMATCH`）。主网**只读**——这是读，不违反规则 8。
- 方法白名单：`eth_chainId`（本地应答，不打上游）、`eth_blockNumber`、`eth_call`、`eth_getBalance`、`eth_getCode`、`eth_getTransactionReceipt`、`eth_getTransactionByHash`、`eth_estimateGas`、`eth_gasPrice`、`eth_getLogs`，以及 S342 联调补的 `eth_getBlockByNumber`（`[块, fullTransactions?]`）、`eth_feeHistory`（blockCount 1…1,024、percentiles ≤ 100 个非递减）；其他 → 422 / `RPC_METHOD_NOT_ALLOWED`（App 映射为 EIP-1193 4200）。
- 参数逐方法严格校验（call 对象只认 from/to/data/input/value/gas/gasPrice/maxFee 字段；不允许 state override 第 3 参；块标签或 hex 块号），不合格 400。
- `eth_getLogs`：`blockHash` 单独使用，或 `fromBlock / toBlock`（标签按 head 解析，`earliest` 视为 0）跨度 ≤ 1,000 块，否则 422 / `RPC_LOG_RANGE_TOO_LARGE`（`detailsSafe.maximumBlockSpan`）；地址 ≤ 20、topics ≤ 4 位 × 20。
- 限流：每账户固定一分钟窗口（`DAPP_RPC_READ_PER_MINUTE`，默认 120，1–6000），超出 429 `RATE_LIMITED`。按账户而非 walletId：一个账户只有一个内置钱包，读请求本身与钱包无关。进程内窗口（同决策 0174）。
- 应答：200 `{ chainId, method, result, error, contractVersion }`；节点回了 JSON-RPC 错误（如 code 3 + revert data）放在 `error` 原样转给页面；节点不可达 / 链未验证 → 503 `CAPABILITY_UNAVAILABLE`；client 不支持转发 → 503 / `DAPP_BROWSER_CHAIN_UNAVAILABLE`。
- 实现：`BscChainCallClient` 新增可选 `relayRead(method, params)`（交互通道、先链验证；`RpcRequestError` → 返回 error，其他 → `BscReadUnavailableError`）。

## 4. 闸门顺序（fail closed）

`dapp-tx` / `dapp-sign`：

1. `DAPP_BROWSER_ENABLED` 关 → 503 `CAPABILITY_UNAVAILABLE` / `DAPP_BROWSER_DISABLED`。
2. 请求形状 → 400；`origin` 为 `http:` → 422 / `ORIGIN_NOT_HTTPS`；非 https、带路径 / query / fragment / 账号 → 400。origin 经 WHATWG URL 规范化（小写 host、punycode、去默认端口）后绑定。
3. 链：`eip155:56` → 422 `VALIDATION_FAILED` / `CHAIN_SIGNING_DISABLED`（规则 8；与 slot 配置无关，永远先拒）；slot 不是独立测试网或无 client → 503 / `DAPP_BROWSER_CHAIN_UNAVAILABLE`；其他链 → 422 `CHAIN_MISMATCH`。
4. （sign）payload 校验：personal_sign 空 / 超长 400；typed data 无效 422 `TYPED_DATA_INVALID`、链不符 422 `TYPED_DATA_CHAIN_MISMATCH`——都在读链之前。
5. `BSC_WRITES_ENABLED` 关或 slot 链未验证 → 503（detailsSafe null，同 send）。
6. 内置钱包；外部钱包 422 `VALIDATION_FAILED`；不存在 404。
7. 幂等：同键同体 200 原 intent；同键异体 409 `IDEMPOTENCY_CONFLICT`。
8. （tx）事实读取失败 → 503；金丝雀对手名单 403 `POLICY_BLOCKED` / `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`；余额不足 409 `INSUFFICIENT_BALANCE`。

错误体一律七字段。`detailsSafe.reasonCode` 全集见 `dappBrowserErrorReasonCodes`。

## 5. 状态机

- `dapp_tx`：同 send——`awaiting_signature`（预执行通过）/ `prepared`（不可签）→ `submitted`（broadcast-report）→ `confirmed / reverted / unknown`（对账 lane）；`cancel`、过期、被新 prepare 顶替（每个钱包同一时刻一个 open intent）照旧。
- `dapp_sign`：`awaiting_signature` → `confirmed`（signature-report 验签通过）；`cancel` / 过期 / 顶替照旧；迟到签名可从 `expired / cancelled` 记为 `confirmed`。App 需串行处理页面的签名请求（新 prepare 会顶替旧的 open intent）。

## 6. 旧客户端兼容（“新值客户端先行”）

- 列表：`dapp_tx`、`dapp_sign` 加入 opt-in kind（`walletIntentOptInKinds`），`GET /v2/wallet-intents` 不带 `includeKinds=dapp_tx,dapp_sign` 时不返回；cursor 绑定 opt-in 集合（沿用 0194）。
- 资源：`review.dapp` 与顶层 `signatureRequest` 只在 DApp kind 上出现，其他 kind 的键集不变；`signing.mode` 新值 `device_personal_sign / device_sign_typed_data_v4`、`simulation.source` 新值 `not_applicable` 只出现在 `dapp_sign` 上；顶层 `decodedCall.functionName` 枚举未改。
- `GET /v2/wallet-intents/{id}`：只有创建它的新客户端知道 ID。
- `/v2/meta/capabilities` 新增 `dappBrowser`（旧客户端按 loop-mobile 决策 0180 跳过未知 id）：`available` = 开关 on + `sendApprovals` 组装 + BSC 写开关 + slot 为独立测试网且有 client；否则 `unavailable`，reasonCode `DAPP_BROWSER_DISABLED` / `SEND_APPROVALS_RUNTIME_DEFERRED` / `BSC_WRITES_DISABLED` / `DAPP_BROWSER_CHAIN_UNAVAILABLE`。旧的 `dappExecution`（deferred）保持不动。
- 钱包活动、approvals 列表不读 `wallet_intents`，不受影响。

## 7. unavailable 行为

开关关、slot 不可用、链未验证、RPC 不可达一律 503，不返回 fixture，不返回假成功；`rpc-read` 不缓存、不合成结果；风险目录查不到就是 `isVerified = false`（不臆测）。

## 8. 已知未做 / 待定

- 规则 9 写着 “DApp 执行只做 unavailable / 只读页面，独立 Go/No-Go”：本批按主代理决策 0270 实现，但开关默认关，开启属于 Go/No-Go 范畴（需主代理确认）。
- 已验证合约 = LOOP 自己配置 / 索引的合约 + Asset Registry `verified` 资产；PancakeSwap 等外部合约一律 `UNVERIFIED_CONTRACT`——提示只在风险时出现，但对外部 DApp 几乎总会出现。是否引入外部白名单待主代理定。
- 金丝雀对手名单（0065）对 DApp 的 `to` 与 counterparty 同样生效：staging 若配置了非空名单，外部 DApp 交易会被 403。
- GoPlus 地址 / 合约筛查仍未接。
- `rpc-read` 限流为进程内窗口；多实例部署时需改共享存储。
- ERC-1155、`wallet_sendCalls`、SIWE 域名与 origin 比对未做。
- BSC Mainnet 签名 / 广播保持关闭；规则解除前 `CHAIN_SIGNING_DISABLED` 不随任何配置变化。
