# LOOP 管理后台与人工运营交接

更新：2026-10-03。分支：`codex/management-operations-20261003`。后端基准：多人协作的 `web3-superapp/loop-api` / `integration/v2`，`83f5ac7`。

本批交付已批准方案的 A 批运营基础、首组真实服务，以及 B1 App 社区管理入口。完整范围见 `docs/superpowers/specs/2026-10-03-management-operations-design.md`。目录中“待补契约”“脚本”“部署配置”等条目仍不是 Web 可操作功能，不能按全部管理功能已完成验收。

## 已接通的功能

| 功能       | 管理入口与行为                                                            | 真实消费端                                              |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| 挖矿配置   | 新建/修订草稿，资产权重、社区系数、参考价格规则；提交独立审批；批准并发布 | 既有 mining repository / snapshot worker / App 挖矿读取 |
| 历史隔离   | 每版本保存社区系数和冻结绑定资产；批准版本不可原地修改                    | 当前、历史算力输入及社区挖矿排序                        |
| 试算与快照 | 创建任务→人工执行→查看结果、输入指纹与完整证据；试算不写正式快照          | 同一个算力引擎；不是客户端重算，也不是奖励发放          |
| 快照撤回   | 按快照 ID 执行撤回，记录理由；不删除历史                                  | 既有快照有效性读取                                      |
| 社区审核   | 授权范围内通过/拒绝；expectedVersion 防并发覆盖                           | 社区状态、原有频道同步任务、站内通知                    |
| 客服       | 已有工单回复、关闭状态机                                                  | 申请人自己的工单事件读取                                |
| 审计       | 操作者、对象、动作、版本、结果、起止时间的服务端查询与分页                | `ops_audit` / 操作结果 / 任务证据                       |
| 异常恢复   | 原 operationId 查询、原请求重试；任务 ID 查询                             | 持久化操作记录与任务，不重复执行业务                    |

社区审核的站内通知与业务写入同事务；推送返回 `not_requested`，不宣称已送达。普通群管理与社区治理是不同模型，本批不把社区管理员权限套到普通群。

## 本地运行和初次授权

使用仓库锁定 Node 24.19.x、pnpm 10.28.x。开发数据库和测试数据库分开，测试库名必须含 `test`。

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start:local
```

真实开发工作台：服务同源 `/ops`。纯本地界面演示：`/ops?preview=1`。演示不请求管理 API、不写数据库、不生成真实奖励或消息。

真实工作台需要当前 Privy access token 和已创建的 LOOP 用户。令牌仅保存在页面内存；刷新/退出清空，不保存到 URL、storage 或日志。当前是 Development 联调入口，尚不是正式生产 SSO 登录。身份由既有 Privy 校验和 LOOP principal 决定，不能从表单指定用户身份。

部署管理员使用受控终端为已有用户配置授权，不提供公开管理员注册，也不能在 Web 自我提权：

```sh
pnpm ops:operator --user <LOOP_USER_UUID> --label '挖矿编辑' --permissions mining.read,mining.edit --confirm
pnpm ops:operator --user <OTHER_LOOP_USER_UUID> --label '挖矿审批' --permissions mining.read,mining.approve --confirm
pnpm ops:operator --user <LOOP_USER_UUID> --label '社区审核' --permissions community.review --scope <COMMUNITY_UUID> --confirm
pnpm ops:operator --user <LOOP_USER_UUID> --revoke --confirm
```

授权命令是**替换**该用户的整份权限集合；需要保留的权限必须一起传入。省略 scope 表示显式全局 `*`；首版只有 community.review 接受社区范围，其他权限为全局且须分别授予。审核日志记录 deployment_cli 执行来源、目标用户及修改前后的 enabled/permissions/scopes；actor_id 为空，不把目标账号冒称为执行人。部署终端操作者本人的身份仍由部署访问日志负责。历史 bootstrap 审计被纠正为 CLI 来源，无法还原的权限前后态保留未知。

权限：`mining.read`、`mining.edit`、`mining.approve`、`mining.snapshot`、`community.review`、`support.manage`、`audit.read`。普通用户有 Privy Token 也不能进入。所有编辑参与者都不能审批该草稿，必须由另一名获授权操作员审批。

## 挖矿操作顺序与故障处理

1. 查看当前版本、资产权重和社区系数。基于完整当前版本创建草稿，或逐项输入新配置。
2. 社区系数必须与 canonical assetId 一起提交；服务器核验绑定、范围、资产存在于公式、同版本资产不冲突。金额、系数均为 decimal string。
3. 试算任务绑定草稿 revision/contentHash。人工执行前重验授权，保存原区块、价格证据、输入 hash 和计算结果。任务最多执行 3 次；撤权或达到上限后 held，修正原因后创建新任务，不能直接改库伪造结果。
4. 提交审批；审批人核对差异、当前生效版本与影响社区，批准并立即发布。编辑后的旧审批无效，并发发布只有与 expectedActiveVersion 一致的请求可成功。
5. 新版本发布后人工生成正式快照。新快照与版本决定 App 后续读数；发布配置本身不改变链上资产，不发放奖励。
6. 超时先记下 operationId 并查询结果；只可用原编号/原内容恢复，不能新建编号盲目重试。任务执行超时先查询原 jobId。

任务由操作员在 Web 明确执行，数据库行锁持有期间防止并发重复执行；没有自动定时调度器。外部依赖缺失或参考价失败会保持未完成/不完整证据，不使用临时价格强行结算。查询历史结果读取保存输入，不重新抓行情替代原证据。

旧公式若历史权重曾被覆盖，迁移只记录能证明的当前关联并标 `legacy_unknown`，不声称还原历史。Web 禁止将这种版本当成完整历史包复制。新版本的权重与绑定从发布起可追溯，修改社区后来绑定不会改变旧版输入。

## 数据库、API 与事务

- 000046：版本化社区权重、冻结绑定、已审批版本不可改；有不可安全降级的数据时拒绝 down。
- 000047：operators/grants、草稿、操作账本、审计。
- 000048：持久化挖矿任务、结果与计算证据。
- 000049：区分 API 用户与部署 CLI 的审计来源，保存授权前后变化；存在 CLI 审计时拒绝有损降级。
- 正式接口契约：`openapi/loop-api.ops.json`；由路由生成，`pnpm openapi:check` 同时检查 V1/V2/Ops。V1/V2 移动端接口不因后台新增而变更。
- `/ops/api/session`、`catalog`、`resources/:resource`、`commands`、`operations/:id`、`jobs/:id`、`jobs/:id/run`。
- `resources/weights` 必须传明确 `configVersion`，每页固定该版本，读取冻结资产；不会跟随中途切换的 active version。
- 命令绑定 actor/action/target/request hash。业务写、结果和成功审计同事务；旧 repository 通过 savepoint facade 复用当前连接。失败审计在回滚后单独记录，不含令牌、供应商返回或请求正文。
- 页面有会话、资源请求及详情代次校验，权限撤销和迟到响应不恢复旧资源。浏览器仅同源 fetch；静态资源 allowlist，禁止任意文件路径，HTML 使用安全文本节点。

## App 社区管理（B1）

移动端在社区资料页集中提供“管理”入口，复用现有成员管理、所有者资料编辑和语音房操作；不改变底部五 Tab。打开与选择操作前均重新读取当前身份权限，撤权、封禁或刷新失败不继续执行；禁言与治理权限按后端分别判断。成员页逐目标 actions 仍由后端决定，没有为普通群虚构管理员契约。

源码位于 loop-mobile 的 `lib/features/community/community_profile_screen.dart`，测试为 `test/community_management_entry_test.dart`。

## 后续仍需开发

B（剩余）：普通群 detail/member directory 与写管理的新契约；平台项目审核、里程碑、白名单导入/root 计算、资产/池/销售登记服务接入。
C：推荐、活动、公告与 App 消费；邀请加成计算、用户/内容治理、AI 文档撤回与授权；用户名/客户端/客服/行情/AI 策略逐项版本化并连接实际消费。
D：频道修复、索引回填等技术运维受控任务；正式部署身份、监控和供应商验收。

以上没有用“通用配置表存 JSON”冒充生效配置。涉及供应商的操作必须区分 LOOP 记录成功、Stream 同步、通知结果；不能因为数据库写成功就显示群管理已完成。

## 合约与资金交接边界

本批不改合约、不发送链上交易、不启用生产经济模型或资金执行。按本会话确认暂写：内盘买卖税 10%、毕业后买卖税 2%；三轮为白名单、优先、公开；NFT 募资买入后的发送目标按项目方称呼为 CZ 地址，准确网络/地址及链上执行证据须由项目方核验，不能自行猜地址或把发送结果等同于 totalSupply 已减少。默认推荐可取消；能人工执行的流程保留人工执行。

双矿池/NFT 权重、真实可领取额、预算拨款、链上 root 发布、买入与转出均须单独合约验收，后台开发数据不构成上述功能完成。

## 验证记录

- 后端单元测试：`pnpm test --maxWorkers=2`，223 个套件、3,366 项全部通过。格式、Lint、类型检查、OpenAPI、构建与 tracked secrets 检查通过。默认高并发曾使原有 5 秒用例超时，未放宽断言或业务时钟。
- PostgreSQL 16 独立测试库已应用 000046–000049。全量 44 个集成套件最后一轮为 538 通过、1 个新增测试 SQL 参数类型失败（42P08）；修正显式 UUID 类型后，运营 16/16 通过，含新增 API 与 CLI 撤权交错回归。其余 43 套件通过。这是“全量运行 + 修正后受影响套件复测”的结果，不宣称同一次全量全绿。
- 先前资源竞争时原有签名过期/迁移超时用例失败，隔离复测 52/52 通过；没有修改这些过期语义。
- 浏览器：1440/380 宽度、窄屏提交、键盘关闭、401 清会话、403 撤权、请求倒序与关闭详情后迟到响应均验证；纯预览不请求管理 API、不写数据库。
- 编译后的服务 `/ops` 返回 200、匿名管理 API 返回 401、真实 PostgreSQL readiness 为 ready；Docker Compose 配置检查通过。
- App：18 项新增管理测试，连同 community_pages 共 111 项通过；相关布局/资料回归此前 116 项通过。407 项 Python harness 测试和 harness 检查通过，修改文件 Dart 分析无诊断。详见移动端 `docs/handoff/2026-10-03-community-management.md`。

环境为本机 PostgreSQL 16；PostgreSQL 17 容器、正式 Privy/Stream/推送、iOS/Android 真机、生产部署均未验收。Flutter analyze 命令遇 SDK 中文路径 LSP 初始化问题，同 SDK 的 Dart analyze 完成替代检查；不把原命令标为通过。
