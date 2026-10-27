# 决策 0187：挖矿矿池名单（平台 MEME 自动入池，结算与快照同口径）（S313-api）

- 状态：已采纳（S313-api），仅 Development / BSC Testnet
- 日期：2026-10-27
- 基线：`793898a`（integration/v2，已含 0183 / 0184 / 0186）
- 依据：需求方 2026-10-27 提出、用户同日裁决：平台发射的 MEME 及其 NFT 自动加入矿池，不再需要后台登记；后台只留一张「矿池」表；App 显示的算力与结算一个口径；列表可按合约地址查。
- 修订：决策 0116 / 0123 的「未登记权重的币权重为 0」只对**矿池名单之外**的资产保留；决策 0125 快照「资产须出现在快照公式 `assetWeights` 里」对名单内资产不再适用。0183（只认已验证社区、成员门槛）、0184（钱包口径开关）不变，名单两条路径都沿用。
- 范围：参数文档两个可选键；结算 runner；快照 lane 的「矿池部分」；后台 `GET /admin/v1/mining/pool`；快照系数接口标 deprecated。**无迁移**（未占用迁移号），不新增 `/v2` 路由或键。

## 1. 实体与 ID

| 实体     | 定义                                                                                                                                      | ID                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 矿池候选 | `communities.verification_status = 'verified'` 且 `bound_asset_key = launch2_instances.chain_id \|\| ':' \|\| meme_address`（任何链）的行 | `communityId`（opaque UUID）× `assetId`（`eip155:{chain}:{meme}`） |
| 参数版本 | 沿用 `mining_parameter_versions.document`（0116），新增两个可选键                                                                         | `versionId`                                                        |

一币一社区（0182 唯一索引），所以候选行 = 已验证社区，一行对应一个 MEME。钱包地址 / ticker 不作关联键；`memeAddress` 只作展示与过滤。

## 2. 有效权重规则（结算与快照共用 `src/features/mining/mining-pool-roster.ts`）

> 候选集 = 已验证社区 × 其绑定的 launch2 MEME（任何链）。
>
> - **币权重** = 参数文档 `assetWeights` 的显式值；未列出 → **1**；列入 `excludedAssets` → **0**（排除优先于显式值）。
> - **NFT 系数** = `communityCoefficients` 的显式值；未列出 → `defaultCommunityCoefficient`（0123 起的文档都是 1）；列入 `excludedCommunities` → **0**。
> - **参与** = 资产与社区都不在两个 excluded 列表里；取消勾选 = 两个都加入。
> - 名单默认 1 只对 `assetPowerBasis = quantity` 的文档生效；0116 `valuation` 文档（只用于回放）保持原表。
> - 非候选资产（BTCB / USDT、MEME v1、未绑定或绑定社区未验证的 launch2 MEME）规则不变：显式权重或 0。

函数：`miningEffectiveAssetWeights(document, candidateAssetIds)`、`miningEffectiveCommunityCoefficients(document)`、`resolveMiningPoolEntry(document | null, candidate)`（后台展示：无已批准版本时显示默认 参与 / 1 / 1）。

## 3. 参数文档（`hourly-settlement-contract.ts`）

| 键                    | 类型            | 约束                        | 缺省 |
| --------------------- | --------------- | --------------------------- | ---- |
| `excludedAssets`      | `assetId[]`     | ≤ 500，唯一，`eip155:N:0x…` | `[]` |
| `excludedCommunities` | `communityId[]` | ≤ 2000，唯一，UUID          | `[]` |

- 旧版本文档没有这两个键，照常解析为空列表；解析结果排序去重。格式错误 → 422 `ADMIN_MINING_PARAMETERS_INVALID`（`field` = 键名）。
- 草稿保存：`communityCoefficients ∪ excludedCommunities` 的社区都须存在且已验证，否则 422 `MINING_COMMUNITY_UNKNOWN`（`detailsSafe.unknownCommunityIds`，`detailsSafe.field` = `communityCoefficients` 或 `excludedCommunities`）；`assetWeights ∪ excludedAssets` 都须有 launch2 / MEME v1 来源，否则 422 `MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`。
- 批准：同样校验 `communityCoefficients ∪ excludedCommunities`（422 `MINING_COMMUNITY_UNKNOWN`）。两人控制（草稿作者 ≠ 审核员）、生效时间在未来等 0116 / 0110 规则不变。

## 4. 结算（`hourly-settlement-runner.ts`）

- 每次结算先读结算链（`LAUNCH_CHAIN_ID`）上的候选 `assetId`（`listMiningPoolCandidates({chainId})`），参数切片的 `assetWeights` / `coefficients` 换成有效值；`admittedAssetIds` 与索引器新鲜度检查也带上名单。其它链上的候选不进结算（结算只读本链 launch2 事实；把它们算进来会让整小时 `ASSET_SOURCE_UNKNOWN`）。
- `input_summary.poolRosterAssetIds` 记录本小时用的名单。**回放**用存下的名单（名单后来变了不影响）；0187 之前结算的小时没有这个键，回放不带名单，摘要与之前一致。没有名单资产、没有排除项时切片与之前逐字节相同，摘要不变。
- 成员门槛（0183）与钱包口径（0184）原样适用：名单 MEME 只算已验证绑定社区成员（含创建者）的持仓。
- 社区榜（按结算小时）的 NFT 邀请单位系数也认 `excludedCommunities`（→ 0）。

## 5. 快照 / App 显示（`mining-pool-snapshot.ts`、`mining-snapshot.ts`、`mining-snapshot-worker.ts`）

快照 lane 增加「矿池部分」（worker 选项 `pool`，`worker-runtime` 与 `pnpm mining:snapshot` 都已接上 launch 链）：

1. 读 launch 链候选；为空 → 与 0187 之前完全相同。
2. 在快照时刻 `at`（秒）对窗口 `[at, at+1)` 读**结算同一套事实**（`readSettlementFacts`：launch2 曲线成交余额 / 毕业后 ERC-20 余额、NFT Transfer、地址归属、成员区间），用**同一个** `prepareMiningHour`（新参数 `windowSeconds = 1`，不算预算）+ `settleMiningHour` 求每人的本人算力。
3. 每个（账户 × 名单 MEME）一行：`power = MEME 余额 × 币权重 + 该 launch 的 NFT 数 × NFT 系数`；`holding` = MEME 余额（18 位小数），`weight` = 币权重，`blockNumber` = launch2 事件 lane 检查点。邀请加成不进快照。
4. 名单资产由矿池部分「拥有」：旧公式路径跳过这些资产的观测余额，不读价格，不要求它们在 `formula.assetWeights` 或 `community_weights` 里。其它资产按旧公式不变。
5. 只有矿池行、没有任何旧公式行时，快照照样 `computed`：`priceVersion = launch2_curve:{at ISO}`，`holdingsSource = chain`。
6. `referencePriceUsd` = 快照时刻之前最后一笔曲线成交后的曲线价（毕业 MEME 即毕业价），`referencePriceQuality = fresh`，代理 / 交易对为 null。它不乘算力（0125），客户端不展示；枚举里没有更贴切的值。

不可用（fail closed，不估算）：没有已批准的参数版本（`MINING_PARAMETERS_PENDING`）、launch2 检查点不存在（`MINING_POOL_CHECKPOINT_MISSING`）、事实读出非法（`MINING_SETTLEMENT_INPUT_INVALID` 等）——这些情况矿池部分整体不出，名单资产按 0187 之前的旧公式路径处理，原因写进 run result 的 `skipped`。单个资产没有资产登记行或被 blocked（`mining_snapshot_powers.asset_id` 外键）→ 跳过该资产（`MINING_POOL_ASSET_UNREGISTERED`）；被排除且无 NFT 算力 → `MINING_POOL_EXCLUDED`。

### `/v2` 兼容（客户端先行）

`/v2/mining/*` **没有新增任何键**，既有键含义不变（客户端 `strictMapWithOptional` 拒绝未知键）。变的只是数值：名单 MEME 出现在 `/v2/mining/assets.included`，`summary.power` / `networkPower` / 成员算力包含 NFT 部分。`included[].power` 在有 NFT 时等于 `holding × weight + NFT 部分`（不再总等于 `holding × weight`）。若以后要分轨展示，需先在 loop-mobile codec 加可选键（如 `nftPower`）发版，再由服务端开关输出——本批不做。

## 6. 后台 `GET /admin/v1/mining/pool`

- 权限 `console.read` 或 `formula.approve`（与 `parameter-versions` 读相同）；`Cache-Control: no-store`。
- query：`address`（MEME 合约地址，精确、大小写不敏感）、`q`（社区名 / ticker 子串，≤ 64）、`cursor` / `limit`（1–100，默认 20，不可同时给）。游标 HMAC 签名（console 会话密钥），绑定过滤条件。
- 响应：`inForce`（当前生效版本引用或 null）、`pendingDraftVersion`（最新待批草稿或 null）、`items[]`、`nextCursor`。每行：`communityId, communityName, assetId, chainId, memeAddress, symbol, instanceId, launchId, participate, tokenWeight, nftCoefficient, source ("default" | "explicit"), pendingDraft (null | {versionId, configVersion, participate, tokenWeight, nftCoefficient, source})`。
- 保存：复用 `POST /admin/v1/mining/parameter-versions`，后台把整表折算成**一个**草稿（规则见 §7），审核员照常批准。

## 7. 整表 → 草稿文档的折算规则（给 loop-admin）

1. 以当前生效版本的文档为底，`referralRatiosBps`、预算、`releaseStartAt` 等其它键原样带上。
2. 对每个名单行：
   - 取消勾选：`assetId` 加入 `excludedAssets`，`communityId` 加入 `excludedCommunities`，并从 `assetWeights` / `communityCoefficients` 去掉这两项。
   - 勾选：两项都不在 excluded 列表；`tokenWeight ≠ "1"` 时写 `{assetId, weight}` 到 `assetWeights`（= 1 可省略）；`nftCoefficient ≠ defaultCommunityCoefficient` 时写 `{communityId, coefficient}` 到 `communityCoefficients`（相等可省略）。
3. 非名单的显式行（BTCB 等资产权重、其它社区系数）原样保留。
4. `communityCoefficients` 必须显式给（哪怕 `[]`）：省略时 0116 的「冻结复制快照权重」会生效。

## 8. 退役「快照系数」页

`/admin/v1/mining/formula-versions` 四个接口保留，OpenAPI 标 `deprecated: true` 并在描述里说明；loop-admin（S313-admin）隐藏入口。名单资产的快照不再依赖它。注意：快照 lane 本身仍要求存在一个已批准的公式版本（`MINING_FORMULA_BASELINE_PENDING` 时整个 lane 空闲，`/v2/mining/*` 读路径也以它为基线）；生产环境该批准被 0110 / 0111 禁止——见「待决」。

## 9. 错误码汇总

| 场景                              | 码                                                                          |
| --------------------------------- | --------------------------------------------------------------------------- |
| pool 列表 query 非法 / 游标不匹配 | 400 `INVALID_REQUEST`                                                       |
| 无权限                            | 403 `PERMISSION_DENIED`                                                     |
| 结算存储不可用                    | 503 `CAPABILITY_UNAVAILABLE`（`MINING_SETTLEMENT_UNAVAILABLE` / DB 不可用） |
| 草稿 / 批准：社区不存在或未验证   | 422 `MINING_COMMUNITY_UNKNOWN`                                              |
| 草稿：资产无来源                  | 422 `VALIDATION_FAILED`（`MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN`）         |
| 草稿：excluded 键格式错误         | 422 `VALIDATION_FAILED`（`ADMIN_MINING_PARAMETERS_INVALID`, `field`）       |

## 10. 测试

- `test/mining-pool-roster.test.ts`：规则（默认 1 / 显式 / excluded / 非候选不入列 / valuation 不带默认 / 无版本显示默认）、文档兼容与校验、结算按新规则的分配不变量、名单与回放、摘要兼容、快照矿池部分（币 + NFT、Launch 链资产、显式 / 排除、成员门槛、不可用分支）、与旧公式合并、仅矿池快照、lane 端到端（不读价格）。
- `test/admin-mining-settlement-routes.test.ts`：pool 列表、权限、地址 / q 过滤、游标分页与过滤绑定、待批草稿列、excluded 键草稿与 `MINING_COMMUNITY_UNKNOWN`。
- `test/mining-pool-roster.integration.test.ts`（PostgreSQL）：候选 SQL（已验证 × launch2、任何链、过滤、keyset）、检查点读取、无显式权重的名单 MEME 结算（只算成员）与回放、同事实的快照矿池部分、批准拒绝未验证的 `excludedCommunities`。

## 待决（交主代理）

1. 社区页 / 社区榜（快照口径，`communityStandingsSql`）仍要求 `community_mining_weights` 的已批准权重，名单社区在社区详情的 `miningPower` 上仍可能是 `COMMUNITY_WEIGHT_PENDING_REVIEW`；账户算力、资产行、排行榜（按账户）已同口径。要不要把社区快照口径也改成名单（需要定义社区 `weight` 投影的含义）。
2. 生产环境没有已批准的快照公式版本时，快照 lane 与 `/v2/mining/*` 读路径整体空闲；若要在生产只靠矿池显示算力，需要把「基线」从公式版本改为参数版本（较大改动）。
3. `referencePriceUsd` 对名单行用曲线价、质量标 `fresh`（枚举限制）；如需要更准确的标注，要客户端先行加枚举值。
