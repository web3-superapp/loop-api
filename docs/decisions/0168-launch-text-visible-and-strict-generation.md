# 0168 · 代币名称 / 代码「可见字符」规则、工厂代际严格判定、启动 Unicode 断言（S256-api，2026-10-20）

## 1. Status

已实现（分支 `fix/S256-launch-text-visible`，基线 `integration/v2` @ `4cb7311`）。来源：loop-contracts 合约审计 S255（`docs/audit/S255-report.md`，分支 `audit/S255-report` @ `38b9fb7`）的 L-6、I-20、I-21。**不改合约、不改数据库约束、不加迁移**（合约 `LaunchText` 底线仍是安全网，决策 0016：合约只做底线，产品规则在链下）。v1 冻结未动；OpenAPI v2 只改描述文字（重新生成）。

## 2. Context

决策 0164 的共享规则（`src/features/launch/launch-token-text.ts`：NFC + trim，1–20 UTF-16 单元，拒控制 / 零宽 / 双向 / 首尾空白）与链上底线都放行「合法但不可见」的串：单个标签字符 `U+E0041`、单个变体选择符 `U+FE0F` / `U+FE00` / `U+E0100`、以组合标记 `U+0301` 开头的串（L-6，冒充 / 制造混乱，不涉资金）。后端把 `launchTextRulesVersion()` 的 2–255 都当 `utf8`（I-21：未来更严的 v3 会被旧后端按 v2 放行）。后端规则 ⊆ 链上底线依赖 Node 的 Unicode ≥ 14（I-20：U+0890/0891 在 Unicode 14 才是 `Cf`）。

## 3. Decision

### 3.1 可见字符规则（L-6）

在 0164 全部规则通过之后再检，顺序固定，一个值只报一个原因：

| 顺序 | 规则                                                                                                | `reasonCode`             | 例                                                      |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| ①    | 至少含一个 `[\p{L}\p{N}\p{S}\p{P}]`（字母、数字、符号含 emoji 与 `$`、标点）                        | `TEXT_NOT_VISIBLE`       | `U+E0041`、`U+FE0F`、`U+FE00`、`U+E0100`、`U+0301` 单独 |
| ②    | 标签字符 `U+E0020–U+E007F` 只能在 `U+1F3F4` + 一个以上 `U+E0020–U+E007E` + `U+E007F` 的旗帜序列内部 | `TAG_OUTSIDE_FLAG`       | `A` + `U+E0041`；未闭合的 🏴 + 标签；🏴 + `U+E007F`     |
| ③    | 不得以 `\p{M}` 开头（变体选择符 `U+FE00–FE0F`、`U+E0100–E01EF` 都是 `Mn`）                          | `LEADING_COMBINING_MARK` | `U+0301` + `abc`；`U+FE0F` + `A`                        |

合法样例：🏴󠁧󠁢󠁥󠁮󠁧󠁿（英格兰旗）、🏴󠁧󠁢󠁳󠁣󠁴󠁿、单独 🏴、`币安人生`、`🐸`、`❤️`（`U+2764 U+FE0F`）、👨‍👩‍👧、`$`、`.`、`1`、`e` + `U+0301`（NFC 后为 `é`）、`a` + `U+0301 U+0302`。

实现：

- `launchTokenTextVisibilityViolation(value)` 返回上述三值之一或 `null`；
- 规则并入 `isCanonicalIdentityText`，因此 `normalizeLaunchTokenText`（项目 create / replace、Hooks 草稿保存与运营保存、MEME create）与 `isOnChainLaunchTokenText`（签名请求、提交体、EIP-712 预检）**都**执行；0168 之前存下的只含不可见字符的草稿不能再取签名请求或提交（`400 INVALID_REQUEST`，重存即可）；
- `launchTokenTextRejectionReason(raw)`：仅当原值通过 0164 全部规则（底线 + 20 单元）、只被可见规则拒绝时返回原因码，否则 `null`（照旧不带细节）。

### 3.2 错误语义（沿用现有码，不新增顶层码）

| 入口                                                              | 顶层码（不变）              | 仅因 3.1 被拒时的 `detailsSafe`                                                                       |
| ----------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /v2/launch/projects`、`PUT /v2/launch/projects/{projectId}` | `400 INVALID_REQUEST`       | `{reasonCode: TEXT_NOT_VISIBLE \| TAG_OUTSIDE_FLAG \| LEADING_COMBINING_MARK, field: name \| ticker}` |
| `PUT /v2/launch/projects/{projectId}/hooks-config`                | `400 INVALID_REQUEST`       | 同上                                                                                                  |
| 运营 `launch.config.save`（admin）                                | `OPS_INVALID_LAUNCH_CONFIG` | 不细分（审核员核对清单见 §5）                                                                         |
| `POST /v2/meme/tokens`                                            | `422 VALIDATION_FAILED`     | `{reasonCode: "MEME_METADATA_INVALID", field: name \| symbol, textReasonCode: <三值之一>}`            |

任务单写的 `HOOKS_LAUNCH_TICKER_INVALID` / `HOOKS_LAUNCH_NAME_INVALID` 是部署模拟回退（`InvalidName` / `InvalidTicker`）的 reasonCode，不是保存入口的码；保存入口现有的是 `INVALID_REQUEST`（launch / hooks）与 `MEME_METADATA_INVALID`（meme），沿用之。MEME 的 `reasonCode` 不改成新值：App 的 `memeReasonText` 按 `MEME_METADATA_INVALID` 出文案，未知值会落到「数据不可得」，所以新原因放在新增的 `textReasonCode` 键（错误体 `detailsSafe` 是标量映射，新增键不影响旧 App 解码）。

### 3.3 工厂代际严格判定（I-21）

`hooksLaunchTextRulesFromVersion(version)`：**只有 `=== 2` → `utf8`**（常量 `hooksLaunchSupportedTextRulesVersion = 2`）；其他值（0、1、3…255）→ `null`，即「读不到」：不缓存，`tickerTextRule()` 抛错，调用方映射为 `503 CAPABILITY_UNAVAILABLE` `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`（hooks-config 保存、签名请求、提交）/ 运营侧 `OPS_UNAVAILABLE`。读到整数但不是 2 时，读取器调用 `onUnsupportedTextRulesVersion(version)`，app 记 `warn`（`launchTextRulesVersion` 字段，消息 `Hooks launch factory text-rules version unsupported; failing closed`）。空 revert → `ascii` 不变。合约若将来发布 v3，后端须随之升级（新决策）才放行。

范围说明：`^[A-Z0-9]{2,12}$` 的代码仍不读链（0164：每一代都接受），所以 v3 工厂上这类代码不会 503；名称从不门控（0164）。

### 3.4 启动 Unicode 断言（I-20）

`src/core/runtime/unicode-runtime.ts` `assertLaunchTextUnicodeRuntime()`：`process.versions.unicode` 主版本 ≥ 14，且探针 `/\p{Cf}/u.test("࢐")` 为真，否则抛 `ConfigurationError`（stderr：`Invalid LOOP API configuration: Node's Unicode tables must be 14 or newer for the launch token text rule (found …); run the pinned Node 24.19`，退出码 1）。调用点：`src/server.ts`、`src/reconciliation-worker.ts`（Hooks 执行器所在进程）的 `main()` 最前。当前 Node 24.19 = Unicode 17。

## 4. unavailable 行为

无新增 Provider / 配置。代际读到非 2 → 503 `HOOKS_LAUNCH_FACTORY_UNAVAILABLE`（fail closed，不缓存，下一请求重读）。

## 5. 给 loop-mobile 的同步规则

App 端创建表单（Launch2 创建者 Hooks 配置、Launch 项目、MEME 创建）在提交前做与服务端相同的本地校验，规则与顺序见 §3.1，Dart 写法：

```dart
final _visible = RegExp(r'[\p{L}\p{N}\p{S}\p{P}]', unicode: true);
final _flag = RegExp(r'\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}', unicode: true);
final _tag = RegExp(r'[\u{E0020}-\u{E007F}]', unicode: true);
final _leadingMark = RegExp(r'^\p{M}', unicode: true);

String? launchTextVisibilityReason(String v) {
  if (!_visible.hasMatch(v)) return 'TEXT_NOT_VISIBLE';
  if (_tag.hasMatch(v.replaceAll(_flag, '\u{1F3F4}'))) return 'TAG_OUTSIDE_FLAG';
  if (_leadingMark.hasMatch(v)) return 'LEADING_COMBINING_MARK';
  return null;
}
```

- 对 `trim()` 后的值检查（服务端先 NFC 再 trim；Dart 无内置 NFC，本地校验只作提示，以服务端为准）。
- 文案：三个原因统一「名称需包含可见字符」（代码字段：「代码需包含可见字符」）；不分开解释。
- 服务端返回 `INVALID_REQUEST` + `detailsSafe.reasonCode ∈ {TEXT_NOT_VISIBLE, TAG_OUTSIDE_FLAG, LEADING_COMBINING_MARK}`（launch / hooks-config）或 `MEME_METADATA_INVALID` + `textReasonCode`（MEME）时，按 `field` 把同一文案标在对应输入框下。
- 无 codec 键变化：只有错误体 `detailsSafe` 多出值 / 键，资源体不变，旧 App 不受影响。
- 审核员核对清单（admin）：名称 / 代码展示为空白或与已有项目视觉相同时退回（L-6 建议）。

## 6. 测试

- `test/launch-token-text.test.ts`：审计样例（`U+E0041`、两标签、`U+FE0F`、`U+FE00`、`U+E0100`、`U+0301` 单独、`́abc`、`U+FE0F`+`A`、标签在旗外 / 未闭合 / 空旗）三种原因；合法样例（英格兰 / 苏格兰旗、中文、emoji、`❤️`、ZWJ 家庭、`$`、`.`、`1`、分解 `é`）；其他规则拒绝时不报可见原因；项目 / Hooks 草稿 / MEME 的 field + reason。
- `test/hooks-launch-project-config.test.ts`：版本 1 / 2 / 3 / 255 / 空 revert 经真实读取器（自定义 transport）；1、3、255 → 拒绝并回调 warn；2 → `utf8`；revert → `ascii`；v3 工厂上保存中文代码 → `HooksLaunchProjectConfigUnavailableError`（503 路径）、不落库。
- `test/unicode-runtime.test.ts`：本机通过；13.0 / 空 / 缺失 / 探针为假 → `ConfigurationError`。
- 路由：`test/v2-launch-routes.test.ts`、`test/v2-hooks-launch-routes.test.ts`、`test/v2-meme-routes.test.ts` 断言 HTTP 错误体的 `detailsSafe`。
