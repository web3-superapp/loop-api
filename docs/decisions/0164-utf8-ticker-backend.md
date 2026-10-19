# 0164 · 代币名称 / 代码按 four.meme 规则、读模型容纳非 ASCII 代码、动态税封顶 50% 文案（S243-api，2026-10-19）

## 1. Status

已实现（分支 `feat/S243-utf8-ticker-backend`，基线 `integration/v2` @ `40921be`）。配合 loop-contracts S242（决策 0016，`b1602a5`）。迁移 `000094_launch_token_text_utf8`（只改三条 CHECK 约束，不改列类型、不动数据）。OpenAPI v2 只改 schema（去 pattern、加长度与描述、50% 文案）；v1 冻结未动。未改 `ops/*.env`。

## 2. Context

需求方裁决：名称与代码规则与 four.meme 一致；动态税上限 50%。S242 合约把 `_validTicker`（ASCII 2–12）换成 `LaunchText` 底线（合法 UTF-8、1–80 字节、拒控制 / 格式 / 双向 / 隐形填充字符、首尾空格、ZWJ 只能在中间），新增错误 `InvalidName()` `0x430f13b3`、`InvalidTicker()` `0x9ceb5e72`，并把 `LoopDynamicDefaults.maxDynamicFeeWad` 改为 `5e17`。0016 §11 列出后端需同步的位置：三条 DB 约束、六处正则、两处 `toUpperCase`、ABI、两处 20% 文案。

## 3. Decision · 规则（后端是权威）

共享模块 `src/features/launch/launch-token-text.ts`（0154 已有，扩展而非新建）：

| 项            | 规则                                                                                                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 函数          | `normalizeLaunchTokenText(raw)`；`normalizeLaunchTokenName` 与 `normalizeLaunchTokenTicker` 是**同一个函数**的别名                                                                                                                                                                                                                     |
| 规范化        | NFC → `trim()`（含全角空格等 JS 空白）；结果原样存储与签名，**不转大写**，不要求唯一                                                                                                                                                                                                                                                   |
| 长度          | trim 后 **1–20 个 UTF-16 单元**（JS `string.length`，与 four.meme 一致：汉字 / 假名 / 谚文各 1，BMP 外 emoji 各 2）；另检 UTF-8 ≤ 80 字节（20 单元最多 60 字节，永远不会触到合约 80 字节底线）                                                                                                                                         |
| 允许          | 任何文字：中 / 日 / 韩 / 带重音拉丁 / emoji（含肤色、国旗、ZWJ 序列、标签序列）/ 中间空格（U+0020、U+3000）/ `$` / 小写 / 数字开头 / 标点                                                                                                                                                                                              |
| 拒绝          | `\p{Cc}`；`\p{Cf}`（放行 U+200D 与 U+E0020–E007F）；`\p{Cs}`、`\p{Zl}`、`\p{Zp}`；除 U+0020 / U+3000 以外的 `\p{Zs}`（NBSP、U+2000–200A、U+202F、U+205F、U+1680）；合约 `_rejected` 表中不属上述类别的：U+034F、U+115F/1160、U+17B4/17B5、U+180B–180F、U+2800、U+3164、U+FFA0、非字符 U+FDD0–FDEF 与各平面 U+xFFFE/xFFFF；ZWJ 在首或尾 |
| 已存 / 已签值 | `isOnChainLaunchTokenText(value)`：同一字符规则 + 已是 NFC 且无首尾空白 + 1–80 字节，**不套 20 单元**。用于签名请求、提交体、EIP-712 预检，使 0154 规则下保存的旧草稿（名称 ≤ 64 字）仍可审批、签名、提交（新工厂接受 ≤ 80 字节）                                                                                                      |

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

`pnpm hooks:abi-sync --protocol <S242 worktree>/protocol`，源提交 `b1602a5`：`loopLaunchFactoryAbi` 与 `loopDynamicLaunchFactoryAbi` 各新增 `error InvalidName()`、`error InvalidTicker()`，其余无差异。`scripts/hooks-launch-abi-selection.ts` 把这两个错误列为两工厂的必选项：旧构建同步会报 missing；`test/hooks-launch-protocol-abi.test.ts` 的构建对比在本机 `loop-contracts`（尚未合并 S242）上按既有规则跳过，指向 S242 构建（`LOOP_PROTOCOL_DIR`）时通过。新增测试用 viem 复核选择器 `0x430f13b3` / `0x9ceb5e72` 并能从两个工厂 ABI 解码。

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

## 10. 未做 / 待主代理定

1. 迁移号按主代理 2026-10-19 调整为 `000094`（S238 用 `000092`、S245-api 用 `000093`）；本分支不含这两个迁移，`schema.ts latestMigrationName` 已设为 `000094_launch_token_text_utf8`。合并时须让 `000092`、`000093` 先于 `000094` 在任何库上执行（node-pg-migrate 默认检查顺序），否则已跑过 `000094` 的库会拒绝补跑前两个。
2. 过渡期：dev / staging 仍指向旧工厂时，后端已放行非 ASCII 代码，签名后会在部署预执行得到 `InvalidConfiguration`（旧工厂无 `InvalidTicker`）→ `HOOKS_DEPLOY_SIMULATION_REVERTED`。若要在换工厂之前按工厂代际拦截（例如 `LAUNCH2_LEGACY_FACTORIES` / code hash 判定），需另定。
3. `test/hooks-launch-protocol-abi.test.ts` 构建对比在 S242 合并进 `loop-contracts` 之前对本机旧构建是跳过的；合并后应在主仓重跑 `pnpm hooks:abi-sync --check`。
4. MEME v1 名称上限由 32 码位收紧到 20 单元（同一规则）；如 v1 需保留 32，需另定。
