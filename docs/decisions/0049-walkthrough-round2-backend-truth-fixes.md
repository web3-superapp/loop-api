# 0049 · 真机走查第二轮归后端的四条真相/标识修正（S27c）

- 日期：2026-09-17
- 来源：`docs/acceptance/2026-09-16-device-walkthrough.md` 第二轮 B-18 / B-14 / D-17 / C-13；主代理任务单 S27c
- 范围：`GET /v2/mining/rank`、`GET /v2/devices`、`GET /v2/launch/overview` + `GET /v2/launch/economy`、`GET /v2/chain/status`、`GET /v2/meta/about`。不加表、不改 migration、不改 `/v1`。
- 基线：`integration/v2` = `d1e53e1`

## 1. B-18 · 算力用户榜的显示名只由隐私中心的匿名模式决定

### 问题

`GET /v2/mining/rank?scope=users` 的 `display` 投影把 `privacy_preferences_v2.discoverable`（隐私中心「显示 LOOP ID / 可被发现」）当成了显示别名的前提：`discoverable && !anonymousMode && alias` 才给别名，否则一律 `anonymous`。走查账号 `cy` 关掉了「可被发现」、开着别名、关着匿名模式，于是本人在榜上被显示成「匿名成员」。

`mining_power_visibility`（`self | everyone`）在排行榜里则完全没有被读取：任何人都能看到任何账号的算力数值。

### 裁决

两个开关各管一件事，互不代替：

| 开关                                   | 决定                             | 不决定                   |
| -------------------------------------- | -------------------------------- | ------------------------ |
| 匿名模式 `anonymousMode`               | 别人看到的是别名还是「匿名成员」 | 算力数值是否可见         |
| 算力可见范围 `mining_power_visibility` | 别人能不能看到我的算力数值       | 我叫什么                 |
| 可被发现 `discoverable`                | 搜索 / LOOP ID 展示（别的模块）  | **排行榜里什么都不决定** |

本人看自己那一行时永远看到自己的别名与算力：自己不可能对自己匿名。

四种组合（`self` = 本人看自己那一行，`other` = 别人看这一行）：

| `anonymousMode` | `mining_power_visibility` | other 看到               | self 看到                          |
| --------------- | ------------------------- | ------------------------ | ---------------------------------- |
| off             | everyone                  | 别名 + 算力              | 别名（`audience: everyone`）+ 算力 |
| off             | self                      | 别名 + `power: null`     | 别名（`audience: everyone`）+ 算力 |
| on              | everyone                  | 匿名成员 + 算力          | 别名（`audience: self`）+ 算力     |
| on              | self                      | 匿名成员 + `power: null` | 别名（`audience: self`）+ 算力     |

`position` 与 `participants` 由快照决定，不受两个开关影响：名次是公开事实，数值才是隐私。

### 接口变化（`items[]` 每行）

- `display.kind = "alias"` 变体新增必填 `audience: "everyone" | "self"`：`self` 只出现在本人行，表示"别人看到的是匿名成员"，前端可据此在本人行加一句说明。
- `power` 从 `string` 变为 `string | null`：`null` 仅当该行不是本人且行主把算力可见范围设为 `self`。
- 新增必填 `powerVisibility: "everyone" | "self"`：行主的设置原样下发（本人行也带，前端可提示"仅自己可见"）。
- 顶层 `display.ruleKey` 由 `mining.rank.display.aliasOrAnonymous` 改为 `mining.rank.display.anonymousModeOnly`，并新增 `display.powerRuleKey = "mining.rank.power.ownerVisibility"`——旧键的中文文案（"仅当可被发现且非匿名"）已不成立，必须换键让前端重写。
- 仓储记录 `MiningRankedAccountRecord` 去掉 `discoverable`，新增 `powerVisibleToOthers`（`coalesce(mining_power_visibility, 'self') = 'everyone'`，与 `listMemberPowers` 相同的默认口径）。

不出现在本决策里的：`myPosition` 不变（本人的名次与算力，本来就只给本人）。

## 2. B-14 · 设备页每行必须能区分

### 问题

同一台模拟器上两条会话的 `platform`/`clientVersion` 完全一致，前端只渲染了这两项加一个相对时间，于是两行字串相同，撤销时分不出谁是谁；而「当前设备 · 最后活跃 6 天前」是因为 `lastSeenAt` 是 bootstrap 观测时间（决策 0027）而前端把它当成了活跃时间。

### 裁决

不加表、不加 header（设备型号需要新的 bootstrap header + 列，见"待主代理决策"），只补投影字段并把口径写清：

- 新增必填 `sessionShortId`：`sessionId` 最后 4 位十六进制，服务端统一定义缩写，两端不会各截各的。
- 新增必填 `isCurrentDevice`：该行的 `deviceId` 等于 `X-Loop-Session-ID` 所指会话的 `deviceId`。与 `isCurrent`（会话级）分开：同一设备的旧会话 `isCurrentDevice: true, isCurrent: false`，正是走查里两行都写「当前设备」的那种情况——前端应把「当前设备」换成「本设备 · 旧会话」。
- `lastSeenAt` 语义不变（bootstrap 观测时间，决策 0027），但 `isCurrent: true` 的行**不要**渲染 `lastSeenAt`，写「正在使用」；`createdAt` 是首次登录时间，必须上屏到分钟。
- 行的唯一显示建议：`platform · clientVersion · 会话 ####（sessionShortId）· 首次登录 createdAt`。

## 3. D-17 · 给用户看的来源标签不用内部标识

- `GET /v2/launch/overview.catalog.source` 与 `GET /v2/launch/economy.source` 由 `"loop_db"`（数据库名）改为稳定枚举 `"loop"`（LOOP 自己的目录/账本），前端映射中文「LOOP 目录」；`schema` 仍 `const`。
- `GET /v2/chain/status.rpc.endpoints[]` 新增必填 `label`：RPC URL 的主机名（`new URL(url).hostname`，例如 `bsc-rpc.publicnode.com`），不含协议、端口、路径、query、userinfo，因此不含任何密钥。`endpointRef` 保留给客户端做键与运维关联。任务单写的 `GET /v2/chain/networks` 不存在，networks 页读的就是 `GET /v2/chain/status`。

## 4. C-13 · 未发布的机制不出现在公开接口里

- `GET /v2/meta/about.configVersions[]`：`bscWriteCanary` 只在 `BSC_WRITES_ENABLED=true`（`config.bscWrites !== null`）时下发；写开关关闭时该行缺席，不是 `unavailable` 占位。
- `clientPolicy` 只有在与 `productPolicy` 的 `configVersion` 不同时才单列（即运营通过 `V2_CLIENT_POLICY_CONFIG_VERSION` 覆盖了版本）；两者相同意味着客户端策略就是产品策略本身，同一个版本号列两次是噪音。
- 其余键保留，逐键中文说明写在 `docs/frontend-v2-meta-api.md`，前端照抄映射。
- 键名不改：它们是 `configVersion` 的模块标识，各模块响应里同样出现（`policy.configVersion`），改名会让 about 页与各页对不上。

## 待主代理决策

- 设备型号 / 设备名：需要新的可选 bootstrap header（例如 `X-Loop-Device-Model`）、`device_sessions.device_model` 列与前端配合，属于会话模块的契约扩展，不在本单范围。
- `lastSeenAt` 是否改为"最近一次由 LOOP 观察到该会话"（在带 `X-Loop-Session-ID` 的请求上更新）：决策 0027 明确留给"设备管理活动与保留策略"模块，本单不改。
