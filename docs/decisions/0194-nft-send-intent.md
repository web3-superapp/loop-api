# 决策 0194：发送 LOOP 项目 NFT——`send_nft` intent + 对账 + 开关默认关（S339-api，主代理决策 0267）

- 状态：已采纳（S339-api）；开关 `NFT_SEND_ENABLED` 默认 `off`
- 日期：2026-11-02
- 基线：`28c2cb9`（integration/v2）
- 依据：`LOOP/docs/53-NFT发送-2026-11-02.md` §一、§二；决策 0035（统一 intent）、0038 / 0077（launch slot 链规则）、0065（金丝雀）、0150（主网 launch slot 需 ACK）、0114（launch2 读模型 / lane）。

## 1. 范围

只发送 **LOOP Launch 项目的 ProjectNFT（ERC-721）**——launch2 lane 已登记（`launch2_instances.nft_address`，activated 或 hold）的合约；一次一枚。链 = launch slot（Development / staging 为 `eip155:97`，主网时为 `eip155:56` 且需 `LAUNCH_MAINNET_ACK`）。外部合集 NFT、ERC-1155、批量发送都不做。

## 2. 实体与稳定 ID

| 实体                        | 主键 / 标识                     | 说明                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet_intents`（新 kind） | `intent_id` uuid（opaque）      | `kind = 'send_nft'`，`chain_id` = launch slot；payload / review 列沿用 000021 冻结触发器                                                                                                                                      |
| 项目 NFT                    | `launch2_instances.instance_id` | 发送路径按 `(chain_id, nft_address)` 反查（000106 新索引）；合约地址只作查找条件，不作关联主键；intent 内的 `review.asset.assetId = <chainId>:<nftAddress>` 只是 review 快照（与 ERC-20 assetId 同格式），不进 Asset Registry |
| `provider_operations`       | 幂等日志                        | `operation_kind = wallet_intent_send_nft`、`domain = bsc`，与 send 同一 `wallet_intent_prepare` scope                                                                                                                         |

迁移 `000106_wallet_intent_send_nft`：放宽 `wallet_intents_kind_check`（加 `send_nft`）+ `launch2_instances_nft_address_idx`。`down` 在存在 `send_nft` intent 时拒绝回滚。无新表。

## 3. 接口

`POST /v2/wallet-intents/send-nft`（Privy Bearer + `Idempotency-Key` UUIDv4 + `X-Loop-Contract-Version: 2.0`）

- 请求：`{ walletId, chainId, contractAddress, tokenId, recipientAddress }`；`tokenId` 十进制字符串（uint256，JSON 数字 400）；未知键 400。
- 响应：与 `/v2/wallet-intents/send` 相同的 `walletIntentResource`（201 新建 / 200 幂等重放）。
  - `kind = send_nft`，`chainId` = launch slot，`unsignedTransaction.chainId = 97`（testnet）。
  - `review.asset = { assetId: "<chainId>:<nft>", address: <nft>, symbol: <ticker>, decimals: 0 }`，`review.amount = { raw: "1", display: "1" }`。
  - `review.decodedCall = { functionName: "safeTransferFrom", selector: "0x42842e0e", args: { from, to, tokenId } }`。
  - `review.nft = { contractAddress, tokenId, projectName }`（主代理 S339 对齐要求；`projectName` 截到 128 码点）——**只在 `send_nft` 的 payload / review 上出现**，其他 kind 不带这个键（旧客户端对 review 是封闭键集），同样进入 `reviewSha256`。
  - `review.balance.rawBalance / displayBalance = "1"`（本 intent 移动的那一枚），`rawNativeBalance` 为 gas 余额。
  - `policy`：`exposureBasis = none`，`valueUsd / priceSource / priceFetchedAt = null`（NFT 无价可估，不计入每日金丝雀额度，同 revoke）。
- `POST /v2/wallet-intents/send/preflight`：开关开且 slot 可用时额外接受 `chainId = <launch slot>`，在该链读 `getCode`；开关关时仍只认 56（其他 → 422 `CHAIN_MISMATCH`）。
- `GET /v2/wallet-intents`：新增可选查询参数 `includeKinds`（逗号分隔的 opt-in kind，目前只有 `send_nft`）。**不带时 `send_nft` 不出现在列表里**（见 §6）；cursor 绑定 opt-in 集合，换集合续页 400。
- `GET /v2/wallet-intents/{id}`、`cancel`、`broadcast-report` 对 `send_nft` 原样适用；读写都走 launch slot 的 client（`runtimeForChain` 新增 nftSend 分支，不依赖 Launch v1 合约配置）。

## 4. 闸门顺序（fail closed）

1. `NFT_SEND_ENABLED` 关 → 503 `CAPABILITY_UNAVAILABLE` / `NFT_SEND_DISABLED`。
2. 请求形状 → 400。
3. `chainId` ≠ launch slot → 422 `CHAIN_MISMATCH`。
4. slot 未开放（主网无 ACK）/ 无 RPC client / 无 launch2 仓库 → 503 / `NFT_SEND_CHAIN_UNAVAILABLE`。
5. `BSC_WRITES_ENABLED` 关或 slot 链未验证 → 503（detailsSafe null，同 send）。
6. 内置钱包（`requireSignableWallet`）；外部钱包 422 `VALIDATION_FAILED`；不存在 404。
7. 发给自己 → 422 / `RECIPIENT_SELF`；零地址 → 400。
8. 合约不是已登记项目 NFT → 422 / `NFT_CONTRACT_UNSUPPORTED`（不读链）。
9. 金丝雀收款名单（非空时）→ 403 `POLICY_BLOCKED` / `COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST`（与 ERC-20 send 一致）。
10. 幂等：同键同体 200 原 intent；同键异体 409 `IDEMPOTENCY_CONFLICT`。
11. `ownerOf(tokenId)`：revert（未铸 / 已销毁）或不是本钱包 → 422 / `NFT_NOT_OWNED`；RPC 读失败 → 503。
12. `eth_call` + `estimateGas`（gas ×1.2 余量）：revert 且收款方是合约 → 422 / `NFT_RECIPIENT_REJECTS`（`onERC721Received` 拒收）；revert 且收款方是 EOA → 409 `SIMULATION_FAILED`；RPC 估算不可用 → intent 以 `prepared` 落库、`signing.allowed = false`（与 send 相同）。
13. gas：`maximumFee > 原生余额` → 409 `INSUFFICIENT_BALANCE`（沿用原生币不足错误码）。
14. 绑定 nonce（pending）、费用、`expiresAt = +120 s`，`sealIntent` → `reviewSha256`。

## 5. 状态机与对账

与 send 完全相同：`awaiting_signature`（预执行通过）/ `prepared`（不可签）→ 客户端 Privy `eth_sendTransaction` → `broadcast-report`（在 slot 上 `eth_getTransactionByHash` 比对 from/to/data/value/nonce/chainId）→ `submitted` → `wallet-intent-reconcile` lane（`launchReadClient` 已存在：`chainId` = slot 的 intent 走 slot client）→ `confirmed` / `reverted` / `unknown`。

持仓：launch2 lane 早已把 ProjectNFT 的 ERC-721 `Transfer` 写入 `launch2_events`，`reprojectPositions` 以 Transfer 的 +1/−1 计 `nft_held`，**无需改索引器**。anvil 套件已加端到端验证：转出后发送方 `nftHeld = 0`、接收方 `nftHeld = 1`。

## 6. 旧客户端兼容（“新值客户端先行”）

loop-mobile `integration/v2` `ebf95629` 的 `LoopV2IntentCodec`：`kind` 只认 send/approve/revoke/swap（未知 → `_invalid()`）、`decodedCall.functionName` 只认 transfer/approve、send 的 `chainId` 锁 56；`intentPage` 对每一项严格解析，任一项失败整页失败。所以旧客户端若在 `GET /v2/wallet-intents` 里读到一条 `send_nft` 会整页解析失败。处理：

- 列表默认排除 `send_nft`，只有带 `includeKinds=send_nft` 的客户端能看到；旧客户端永远看不到。
- `GET /v2/wallet-intents/{id}`：只有创建它的新客户端知道这个 ID；不另做隐藏。
- 钱包活动（`/v2/wallet/...activity`、launch2 合并活动）不读 `wallet_intents`，也不新增 NFT Transfer 活动行，所以不受影响。
- `/v2/meta/capabilities` 新增 `nftSend`：ebf95629 的 `LoopV2MetaRepository` 按 loop-mobile 决策 0180 跳过未知 capabilityId（只要求已知 id 齐全），所以旧客户端安全。`available` = 开关 on + `sendApprovals` 组装 + BSC 写开关 + slot 开放且有 client 与 launch2 目录；否则 `unavailable`，reasonCode `NFT_SEND_DISABLED` / `SEND_APPROVALS_RUNTIME_DEFERRED` / `BSC_WRITES_DISABLED` / `NFT_SEND_CHAIN_UNAVAILABLE`。

## 7. 已知未做 / 待定

- 持仓默认只给 `nft.mintedTokenId` 与 `nft.held`，收到的 NFT 没有 tokenId。已实现可选键 `nft.heldTokenIds: string[]`（每个 token 最后一条未 removed 的 ERC-721 `Transfer` 的 `to` 即当前 owner；升序、≤ 100），出现在 launch2 instance `viewer.nft` 与 `/v2/launch2/me/positions` 的 `nft`。ebf95629 的 launch2 codec `_nftHolding` 是 `strictMap({mintedTokenId, held})`，故放在 `LAUNCH2_NFT_HELD_TOKEN_IDS_EMIT`（默认 off）后，客户端先行后再开。
- `isFirstRecipient` 仍基于 `indexed_transfers`（ERC-20 lane）在该链上的记录；testnet 上通常恒为 true。
- GoPlus 地址筛查仍 `unavailable`。
- BSC 主网签名 / 广播保持关闭：主网 slot 需 `LAUNCH_MAINNET_ACK` + `BSC_WRITES_ENABLED` 才会走到构建。
