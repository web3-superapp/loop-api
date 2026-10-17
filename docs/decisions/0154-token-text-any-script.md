# 0154 · MEME / Launch 代币文本不设语言限制（S223-api，2026-10-17）

## 1. Status

已实现（分支 `feat/S223-unicode-token-names`，基线 `861031d`）。无迁移、无 SQL 变化，未改 `ops/*.env`。OpenAPI v2 只多了字段 `description`（v1 冻结未动）。

## 2. Context

需求方 2026-10-17：「合约上发币不要做中英文限制，前端、移动端也都不要做」。盘点结果：

| 面                                                                                                      | 名称 name                                                     | 代码 ticker                                                    | 简介 narrative / description     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| 合约 `LoopLaunchFactoryCore._validateRequest`（`LoopLaunchFactory` 与 `LoopDynamicLaunchFactory` 共用） | `1 ≤ bytes(name).length ≤ 64`，**不限字符集**                 | `_validTicker`：2–12 字节，只许 `0-9`、`A-Z`（**ASCII 限制**） | 不上链（只进 `configHash`）      |
| `MemeToken` / `LaunchModuleDeployers` / `CurveEngine`                                                   | 原样传给 OZ `ERC20(name, symbol)`，无校验                     | 同左                                                           | —                                |
| EIP-712 `LaunchRequest`                                                                                 | `keccak256(bytes(name))`，任意 UTF-8                          | `keccak256(bytes(ticker))`                                     | —                                |
| API 项目 `POST/PUT /v2/launch/projects`                                                                 | 1–80 码位，禁 `\p{Cc}\p{Cf}…`；**无语言限制但不知道 64 字节** | `^[A-Z0-9]{2,12}$`（与合约一致）                               | 1–2000 码位；`\p{Cc}` 连换行也禁 |
| API `PUT …/hooks-config`（被签名、上链的那份）                                                          | trim 后 ≤ 64 **UTF-16 单元**                                  | `^[A-Za-z0-9]{2,12}$` → 大写                                   | ≤ 2000 UTF-16 单元               |
| `public.assets` 注册（`isRegistrableTokenIdentity`）                                                    | 1–128 码位、无控制字符，任意文字                              | 1–32 码位，任意文字                                            | —                                |
| 搜索（`community/asset-search`）                                                                        | NFKC + 小写比较，任意文字                                     | 同左                                                           | —                                |

结论：现有后端**没有**中英文限制；但有一个潜在缺陷——名称按字符（或 UTF-16）计 64，而合约按**字节**计 64，22–64 个汉字的名称能过 API、在链上 `InvalidConfiguration` revert。代码的 ASCII 限制在**合约**里，后端只是与之一致。

## 3. Decision

新模块 `src/features/launch/launch-token-text.ts`，项目（create / replace）与 hooks-config 草稿共用：

1. **不设语言 / 文字限制**：中文、英文、混排、日韩、带重音字母、emoji（含 ZWJ 组合 👨‍👩‍👧、旗帜标签序列 🏴󠁧󠁢󠁳󠁣󠁴󠁿）都可。
2. **保留的安全限制**：
   - 名称禁止全部 `\p{Cc}`（含换行、制表）；简介保留 `\n`、`\t`，`\r\n` / `\r` 折叠为 `\n`（修正：以前项目简介连换行都 400，而移动端简介是多行输入）。
   - 禁止 `\p{Cf}`（含双向覆写 U+202A–202E / U+2066–2069、零宽空格 U+200B 等，防伪装）、`\p{Cs}`、`\p{Zl}`、`\p{Zp}`；例外放行 U+200D（ZWJ）与 U+E0020–E007F（emoji 标签字符）。
   - 首尾空白去掉（含全角空格），不存储；内部空白原样。
   - **NFC 规范化**（仓库 `meme-contract.ts` 已有同样做法），一个可见名称只有一种字节序列，配置哈希与签名请求一致。
3. **长度按字符（Unicode 码位）计**，名称另有链上字节上限：
   - 名称：≤ 64 字符 **且** ≤ 64 UTF-8 字节（合约上限）。UTF-8：ASCII 1 字节、汉字 / 假名 / 谚文 3 字节、emoji 4 字节 → **英文 64 个、中文 21 个、emoji 16 个**；混排按字节累加（例「狗狗 Doge 2026」= 6+1+4+1+4 = 16 字节）。项目名上限由 80 字符收紧为同一规则（> 64 字节的名称本来就无法上链）。
   - 简介：≤ 2000 字符（运营审核读回时也改为按码位，不再按 UTF-16 单元，emoji 不再算 2）。
4. **代码 ticker 不变**：`^[A-Z0-9]{2,12}$`（hooks-config 接受小写并转大写；项目要求大写）。这是已部署工厂 `_validTicker` 的链上规则，不是我们的语言政策；在合约换工厂前放开只会制造上链必 revert 的项目，故保持 fail-closed。`launch2_read_model.ticker` 与 `launch_projects.ticker` 的 DB check 同样保持。
5. 读面（`public.assets`、市场 / 社区搜索与展示）本来就不假设 ASCII 或大写，不改。

## 4. 需要另行裁决：合约放开 ticker

若要支持中文代码，需改 `LoopLaunchFactoryCore._validTicker`，建议改为：`1 ≤ bytes ≤ 32`（中文 10 个），拒绝 `< 0x20`、`0x7f`，其余字节交给后端规范化（链上无法做 Unicode 类别判断，合约只兜底控制字符）。影响：

- 工厂不可升级 → 重部署 `LoopDynamicLaunchFactory`（及其 deployer 绑定），已有实例留在旧工厂（0153 的按工厂解析已支持）。
- `TEMPLATE_HASH` 只承诺参数，不承诺字节码；改校验本身不变模板哈希，但重部署会换工厂地址（EIP-712 domain 变），后端 `LAUNCH2_DYNAMIC_FACTORY_ADDRESS` 与旧工厂名单要更新。
- 需要增量审计（`_validateRequest` 属输入校验，影响面小）。
- 之后后端把 ticker 改为与名称同一套文字规则 + 字节上限，`launch_projects` / `launch2_*` 的 ticker check 需新迁移。

## 5. Tests

`test/launch-token-text.test.ts`：中文 / 中英混排 / emoji / ZWJ / 旗帜 / 日韩 / 重音通过；NFC 与首尾空白；64 ASCII 过、65 拒；21 汉字（63 字节）过、22 拒；16 emoji 过、17 拒；换行 / 制表 / NUL / DEL / 双向覆写 / 零宽空格 / 行分隔 / 孤立代理拒；简介保留换行、折叠 CRLF、按码位计 2000；项目与 hooks 草稿两个入口；中文 ticker 仍拒。
