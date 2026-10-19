# 0164 · 代币名称 / 代码按 four.meme 规则、读模型容纳非 ASCII 代码、动态税封顶 50% 文案（S243-api，2026-10-19）

## 1. Status

已实现（分支 `feat/S243-utf8-ticker-backend`，基线 `integration/v2` @ `40921be`）。配合 loop-contracts S242（决策 0016，`b1602a5`）。迁移 `000094_launch_token_text_utf8`（只改三条 CHECK 约束，不改列类型、不动数据）。OpenAPI v2 只改 schema（去 pattern、加长度与描述、50% 文案）；v1 冻结未动。未改 `ops/*.env`。

## 2. Context

需求方裁决：名称与代码规则与 four.meme 一致；动态税上限 50%。S242 合约把 `_validTicker`（ASCII 2–12）换成 `LaunchText` 底线（合法 UTF-8、1–80 字节、拒控制 / 格式 / 双向 / 隐形填充字符、首尾空格、ZWJ 只能在中间），新增错误 `InvalidName()` `0x430f13b3`、`InvalidTicker()` `0x9ceb5e72`，并把 `LoopDynamicDefaults.maxDynamicFeeWad` 改为 `5e17`。0016 §11 列出后端需同步的位置：三条 DB 约束、六处正则、两处 `toUpperCase`、ABI、两处 20% 文案。

## 3. Decision · 规则（后端是权威）

共享模块 `src/features/launch/launch-token-text.ts`（0154 已有，扩展而非新建）：

| 项            | 规则                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 函数          | `normalizeLaunchTokenText(raw)`；`normalizeLaunchTokenName` 与 `normalizeLaunchTokenTicker` 是**同一个函数**的别名                                                                                                                                                                                                                                                                                                                                    |
| 规范化        | NFC → `trim()`（含全角空格等 JS 空白）；结果原样存储与签名，**不转大写**，不要求唯一                                                                                                                                                                                                                                                                                                                                                                  |
| 长度          | trim 后 **1–20 个 UTF-16 单元**（JS `string.length`，与 four.meme 一致：汉字 / 假名 / 谚文各 1，BMP 外 emoji 各 2）；另检 UTF-8 ≤ 80 字节（20 单元最多 60 字节，永远不会触到合约 80 字节底线）                                                                                                                                                                                                                                                        |
| 允许          | 任何文字：中 / 日 / 韩 / 带重音拉丁 / emoji（含肤色、国旗、ZWJ 序列、标签序列）/ 中间空格（U+0020、U+3000）/ `$` / 小写 / 数字开头 / 标点                                                                                                                                                                                                                                                                                                             |
| 拒绝          | `\p{Cc}`；`\p{Cf}`（放行 U+200D 与 U+E0020–E007F）；`\p{Cs}`、`\p{Zl}`、`\p{Zp}`；除 U+0020 / U+3000 以外的 `\p{Zs}`（NBSP、U+2000–200A、U+202F、U+205F、U+1680）；合约 `_rejected` 表中不属上述类别的：U+034F、U+115F/1160、U+17B4/17B5、U+180B–180F、U+2800、U+3164、U+FFA0、非字符 U+FDD0–FDEF 与各平面 U+xFFFE/xFFFF、U+2065（合约整段拒 U+205F–206F 中唯一的未分配码点；不整体拒 `\p{Cn}`，以免运行时 ICU 版本较旧时误拒新 emoji）；ZWJ 在首或尾 |
| 已存 / 已签值 | `isOnChainLaunchTokenText(value)`：同一字符规则 + 已是 NFC 且无首尾空白 + 1–80 字节，**不套 20 单元**。用于签名请求、提交体、EIP-712 预检，使 0154 规则下保存的旧草稿（名称 ≤ 64 字）仍可审批、签名、提交（新工厂接受 ≤ 80 字节）                                                                                                                                                                                                                     |

结论：后端放行的任何值都满足合约 `LaunchText` 底线（后端严格包含合约规则）；合约是兜底。

### 入口与比对

| 位置                                                                                         | 改动                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `launch-contract.ts` 项目 create / replace                                                   | ticker 走 `normalizeLaunchTokenTicker`（原 `^[A-Z0-9]{2,12}$`）；`launchTickerPatternSource` 删除                               |
| `hooks-launch-config.ts` `parseHooksLaunchDraft`                                             | 删 `tickerPattern`，ticker 走共享函数；`ticker: input.ticker.toUpperCase()` → 规范化原值（大小写进入 `configHash`）             |
| `hooks-launch-review.ts` 运营保存                                                            | zod 只做形状（trim、1–256），规则由仓储里的 `parseHooksLaunchDraft` 执行                                                        |
| `hooks-launch-submission.ts`                                                                 | 请求 name / ticker 用 `isOnChainLaunchTokenText`；`draft.config.ticker.toUpperCase() !== request.ticker` → 原样比对             |
| `hooks-launch-deployment.ts`                                                                 | 签名请求 `ticker: draft.config.ticker`（去 `toUpperCase`）                                                                      |
| `hooks-launch-deployment-crypto.ts`                                                          | EIP-712 预检 name / ticker 用 `isOnChainLaunchTokenText`（原 `length ≤ 64`、`^[A-Z0-9]{2,12}$`）                                |
| `meme-contract.ts`（MEME v1 `POST /v2/meme/tokens`）                                         | name 与 symbol 都走共享函数（原 name 1–32 码位、symbol `^[A-Z0-9]{2,10}$`）；`LoopMemeCurve.createToken` 不校验文本，链上无阻碍 |
| 部署核验 `hooks-launch-verification.ts:424`、`hooks-launch-loop-dynamic-verification.ts:360` | 本来就是 `meme.symbol === expected.ticker` 原样比对，未改                                                                       |

已存草稿的 ticker 是旧规则下转好的大写 ASCII，去掉 `toUpperCase` 对它们没有影响（幂等）。

### 错误码

不新增 HTTP 错误码：项目 / MEME / hooks-config 仍分别是既有的 400 `VALIDATION_FAILED`（`invalid_launch_request`）、422 `VALIDATION_FAILED` + `MEME_METADATA_INVALID`（`field: name|symbol`）、hooks-config 既有的 `InvalidHooksLaunchDraftError` 映射。部署执行器新增两个任务 `failure.code`（不可重试）：部署预执行 revert 名为 `InvalidName` → `HOOKS_LAUNCH_NAME_INVALID`，`InvalidTicker` → `HOOKS_LAUNCH_TICKER_INVALID`；其它 revert 仍为 `HOOKS_DEPLOY_SIMULATION_REVERTED`。典型触发：非 ASCII 代码签给了未换代的旧工厂。

## 4. ABI

`pnpm hooks:abi-sync --protocol <S242 worktree>/protocol`，源提交 `a1c4906`：`loopLaunchFactoryAbi` 与 `loopDynamicLaunchFactoryAbi` 各新增 `error InvalidName()`、`error InvalidTicker()` 与 `function launchTextRulesVersion()`（§10），其余无差异。`scripts/hooks-launch-abi-selection.ts` 把这两个错误列为两工厂的必选项：旧构建同步会报 missing；`test/hooks-launch-protocol-abi.test.ts` 的构建对比在本机 `loop-contracts`（尚未合并 S242）上按既有规则跳过，指向 S242 构建（`LOOP_PROTOCOL_DIR`）时通过。新增测试用 viem 复核选择器 `0x430f13b3` / `0x9ceb5e72` 并能从两个工厂 ABI 解码。

## 5. 迁移 `000094_launch_token_text_utf8`

| 表.列                                                                               | 旧约束                 | 新约束（同名）                                                        |
| ----------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `launch_projects.ticker`（`launch_projects_ticker_check`，000023）                  | `~ '^[A-Z0-9]{2,12}$'` | `octet_length between 1 and 80` 且 `= btrim(x, ' '‖TAB‖LF‖CR‖U+3000)` |
| `launch2_instances.ticker`（列级、自动名 `launch2_instances_ticker_check`，000061） | 同上                   | 同上                                                                  |
| `meme_tokens.symbol`（`meme_tokens_symbol_check`，000049）                          | `~ '^[A-Z0-9]{2,10}$'` | 同上                                                                  |

字符规则只在应用层。`down` 恢复旧正则；任一表存在不符合旧正则的行时 `raise exception`（整个 down 回滚，不删 / 不改数据），须先由运营处理这些行。

`launch2_instances.name`（`char_length 1–64`）未改：唯一写入路径是激活投影从已签配置复制，而签名只放行 ≤ 20 单元的新值与 ≤ 64 字的旧草稿。

**上线顺序（0016 §10 第 5 步）**：本迁移须在测试网第一个非 ASCII 代码之前上 dev 与 staging，否则激活投影 `registerActivatedInstances` 插入 `launch2_instances` 会因旧 CHECK 失败（`on conflict do nothing` 不吞 CHECK 错误），链上项目在 App 不可见。

## 6. 读模型 / 索引器逐条核对

- `launch2_instances` 唯一写入：`launch2-repository.ts registerActivatedInstances`，`v.config ->> 'ticker'` 原样复制；`on conflict do nothing` 只针对 `job_id` 唯一，与 ticker 无关；无 ticker 唯一索引 / 搜索索引（全仓 migrations 无 ticker / symbol 索引）。
- `meme_tokens` 唯一插入：`meme-repository.ts:1266`（create 已校验的值）；`meme-repository.ts:2128` 与链上事件 `symbol` 原样比对。
- `public.assets` 注册（`launch2-meme-assets.ts isRegistrableTokenIdentity`：1–32 码位、无控制字符、无首尾空白；DB `assets_symbol_check` 同）：≤ 20 单元的值必过。
- 搜索 `community/asset-search.ts`：NFKC + 小写比较，不假设 ASCII。
- 后端无 `$` 拼接 ticker 的显示逻辑（`loopTickerLabel` 只在 App）；push 文案不含 ticker。Square `square-repository.ts` 原样透传 `launch2_ticker`。

## 7. 动态税 50%

`maxDynamicFeeWad` 全仓无写死 `2e17` 的校验：`hooks-launch-manifest.ts` 从 manifest 读（JSON 数字 `5e17` 在 double 中精确，转 `BigInt` 后按 `< 1e18` 校验）；`launch2` 读面从链上 `maxDynamicFeeWad()` 读。只改文案：`launch-schemas.ts`（模板 `maxDynamicFeeWad` 描述）、`launch2-schemas.ts`（`maxDynamicFeeWad` 描述），以及 `hooks-launch-config.ts` 注释：S242 裁决值 0.5（50%，卖出侧总上限 51%），S193 工厂仍为 0.2。

## 8. OpenAPI

- 项目 create / replace 请求 ticker：去 pattern，`minLength 1`、`maxLength 4096`（原始长度，规则在 trim 后）+ 规则描述；hooks-config name / ticker：`maxLength 256` + 描述。
- 项目 / launch / 审核详情 / 签名请求 / launch2 读面 ticker：`minLength 1`、`maxLength 80`；签名请求 name 同。
- MEME create `symbol`：`maxLength 256` + 描述。

## 9. Tests

- `test/launch-token-text.test.ts`：同一函数；中文、emoji、混排、假名、`四`、`$1`、`doge`、`1inch`、`フリーダム.オブ.マネー`、中间全角空格通过；不转大写（`straße`）；20 单元边界（ASCII / 汉字 20 过、21 拒；emoji 10 过、11 拒）；首尾空格去掉；控制 / 双向 / 零宽 / NBSP / 其它空格 / 软连字符 / CGJ / 填充符 / 盲文空白 / BOM / 非字符 / 首尾 ZWJ 拒；`isOnChainLaunchTokenText` 不 trim、不套 20；项目 / hooks 草稿（大小写进入 configHash）/ MEME 三个入口。
- `test/s243-migrations.test.ts`：up 三表 drop + add、无正则、不动数据；down 恢复旧正则且三处 `raise exception`。
- 集成：`test/launch-token-text-migration.integration.test.ts`（真 Postgres）：up 后三表能写 `狗狗币` / `$1` / emoji、拒空串与首尾空格、拒 81 字节；down 在有非 ASCII 行时报错，清理后 down 恢复旧正则。
- `test/hooks-launch-executor.test.ts`：`InvalidName` / `InvalidTicker` 预执行 revert → 两个新 failure code。
- `test/hooks-launch-protocol-abi.test.ts`：选择器与解码。
- 既有用例改写：小写 ticker / symbol 现在合法（`launch-contract`、`meme-curve-math`、`v2-launch-routes`、`v2-meme-routes`）。

## 10. 过渡门控（主代理 2026-10-19 裁决，追加提交）

**目的**：配置的发射工厂仍是 S242 之前的代际时，非 `^[A-Z0-9]{2,12}$` 的代码（中文、小写、`$1`、单字符……）在保存 / 签名 / 提交阶段就以字段级错误拒绝，不再走到部署模拟才失败；换成 S242 工厂后自动放开，不改 env。

**代际怎么判**：manifest 与模板哈希都判不出来——manifest 只在部署检查与测试里用、运行时不读（0152）；OfficialTax 的 `TEMPLATE_HASH` 恒为 `keccak256("hooks_launch_v1")`，LoopDynamic 的模板哈希只随参数（`maxDynamicFeeWad`）变；运行时 code hash 含 immutables，每次部署都不同。主代理因此让 S242 在两个工厂上加 `launchTextRulesVersion() external pure returns (uint8)`（selector `0x231cd5bd`，返回 2；loop-contracts `a1c4906`），后端 `createHooksLaunchFactoryReader().tickerTextRule()` 在已通过网络 / code hash 校验的工厂上 `eth_call` 它：

- 返回 ≥ 2 → `utf8`（S242+）；
- revert 且无返回数据、或调用返回 `0x` → `ascii`（旧工厂没有该函数）。认作「无此函数」的节点形态（`isHooksLaunchMissingFunctionRevert`，单测逐一覆盖）：publicnode `{code: 3, message: "execution reverted", data: "0x"}`；BNB Chain 官方 seed `{code: 3, message: "execution reverted: 0x", data: "0x"}`；geth 系（NodeReal）`{code: -32000, message: "execution reverted"}`（无 `data` 或 `data: "0x"`）；`result: "0x"`。reason 只接受 `/^execution reverted(: 0x)?$/`，且整条错误链上不得有非空 `data`
- RPC / 传输错误、超时、带数据或带其它 reason 的 revert、返回 0 / 1 等非预期值 → 判不出，**fail closed**（503 `CAPABILITY_UNAVAILABLE` / `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`，运营端 `OPS_UNAVAILABLE`）。
- 只读 `eth_call`；结果按工厂（reader 实例 = 一个固定 code hash 的工厂地址）缓存，判不出不缓存。
- reader 没有该方法（测试替身）按 `ascii` 处理。合法的旧格式代码（`^[A-Z0-9]{2,12}$`）任何代际都放行，**不读链**，现有流程零额外 RPC。
- 早期草稿曾用模拟 `deployLaunch` 的 revert 顺序推断代际，依赖工厂检查顺序，已删除。
- anvil 实测：S242 构建（`a1c4906`）→ `utf8`，`狗狗币` 走完签名 → 部署 → 核验 → 激活，链上 `symbol()` 原样为 `狗狗币`；本机 `loop-contracts`（S242 前）→ `ascii`（函数不存在，revert 无数据），签名请求被拒、无任务。

**门控位置**（都在任何写入之前）：

| 入口                                                                                                                           | 拒绝                                                                                                                     | 探测失败                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `PUT /v2/launch/projects/{projectId}/hooks-config`（`hooks-launch-project-config.ts saveDraft`，`parseHooksLaunchDraft` 之后） | 422 `VALIDATION_FAILED`，`detailsSafe {reasonCode: "HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY", field: "ticker"}`       | 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE` |
| `GET …/hooks-config/signing-request`（`hooks-launch-deployment.ts`，与其它工厂读并发、计入 8 s 预算）                          | 同上                                                                                                                     | 同上                                   |
| `POST …/hooks-deployments`（`hooks-launch-submission.ts`，同上）                                                               | 同上，不建任务                                                                                                           | 同上                                   |
| 运营保存 `launch.config.save`（`hooks-launch-review.ts`）                                                                      | `OPS_TICKER_UNSUPPORTED_BY_FACTORY` → 后台 `VALIDATION_FAILED` / reasonCode `HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY` | `OPS_UNAVAILABLE`                      |

建议文案（客户端按 reasonCode 显示）：「当前发射工厂暂不支持该代码格式，请使用 2–12 位大写字母或数字」。

**项目目录（`POST/PUT /v2/launch/projects`，`launch-contract.ts`）不加门控**：项目不绑定工厂，项目 `ticker` 也不上链；上链与签名的是 hooks-config 的 `config.ticker`，它在保存 / 签名 / 提交三处都已门控。审查意见里「签名请求（`launch-contract.ts:292` 附近）」那一行是项目目录的 ticker 解析；签名请求的实际入口是 `hooks-launch-deployment.ts prepareSigningRequest`，已门控。

## 11. 合并清单

1. 迁移：`000092`（S238）、`000093`（S245-api）、`000094`（本分支）**必须在同一次合并里一起上**，按 92 → 93 → 94 在每个库（dev、staging、测试库）上执行；`schema.ts latestMigrationName` 合并后统一为最大号，各分支硬编码「最新迁移」的测试一并改。node-pg-migrate 默认检查顺序：已跑过 `000094` 的库不能再补跑 `000092` / `000093`。
2. S242（含 `a1c4906` 的 `launchTextRulesVersion`）合并进 `loop-contracts` 后，在 loop-api 主仓跑 `pnpm hooks:abi-sync --check`（应输出 `ABI matches the Foundry build`）；`test/hooks-launch-protocol-abi.test.ts` 的构建对比此时不再跳过。
3. 0016 §10 第 5 步：本迁移须先于测试网第一个非 ASCII 代码上线到 dev 与 staging。过渡门控保证在换工厂之前不会签出这种代码。

## 12. 未做 / 待主代理定

1. MEME v1 名称上限由 32 码位收紧到 20 单元（主代理 2026-10-19 已接受：创建默认 410）。
