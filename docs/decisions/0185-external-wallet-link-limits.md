# 决策 0185：已登录账号绑定外部钱包的服务端规则（S306-api）

- 状态：已采纳（S306-api），仅 Development / BSC Testnet
- 日期：2026-10-25
- 基线：`6c8b911`（integration/v2，已含 S304 / 决策 0184）
- 依据：用户 2026-10-25 裁决（开放「已登录账号绑定外部钱包」）；决策 0033（钱包清单以 Privy 为准）、0063 / 0086（Privy 清单复用窗口）、0116（小时结算地址归属）、0162（成交流水的钱包 → 账号映射）、0183 / 0184（挖矿钱包口径）。
- 范围：迁移 `000102_account_wallet_archived_reason`；`account-wallet-repository` 同步逻辑；新接口 `POST /v2/wallets/sync`；`GET /v2/wallets`、`PUT /v2/wallets/active` 的可选键（开关后发）；两个新 env：`WALLET_LINK_POLICY_EMIT`（off|on，默认 off）、`EXTERNAL_WALLET_ADDRESS_PUBLIC`（true|false，默认 false）。

## 五条裁决与落点

| #   | 裁决                                       | 服务端落点                                                                                                                                                                                                                             |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 外部钱包算算力                             | 不改。`MINING_EMBEDDED_WALLET_ONLY` 保持默认 `false`（决策 0184）。                                                                                                                                                                    |
| 2   | 每个账号最多 3 个外部钱包                  | 常量 `externalWalletLimit = 3`（`src/features/chain/chain-contract.ts`）。同步时超出的外部钱包归档，原因 `external_limit_exceeded`，不计算力、不做成交归属、不能被选为当前钱包。                                                       |
| 3   | 钱包已属于另一账号时不合并                 | 同步层兜底：该地址已是另一账号的 active 钱包时，本账号这一行写成归档 + `address_conflict`，记 warn（只记 `ownerUserId` / `walletId`，不记地址），不产生第二个归属人。用户须先在旧账号解绑（Privy unlink + 旧账号同步）再在新账号同步。 |
| 4   | 外部钱包地址对外展示做成开关，默认不展示   | `EXTERNAL_WALLET_ADDRESS_PUBLIC`（严格布尔，默认 `false`），见下文「暴露面检查」。                                                                                                                                                     |
| 5   | 随时可解绑，解绑后算力立即停（下一小时起） | Privy unlink 后 App 调 `POST /v2/wallets/sync`：该钱包归档（`unlinked`）。快照下一轮起不计；结算在小时结束后读当时的 `account_wallets`，所以**解绑发生的那个小时本身**就已不归属（比「下一小时起」更早停，不会多给）。                 |

## 存储（迁移 000102）

`account_wallets` 新增 `archived_reason text null`：

| 值                        | 含义                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `unlinked`                | Privy 不再报告该钱包（用户解绑，或钱包转到别的 Privy 用户） |
| `external_limit_exceeded` | Privy 报告了，但账号已有 3 个 active 外部钱包               |
| `address_conflict`        | Privy 报告了，但该地址已是另一 LOOP 账号的 active 钱包      |
| `null`                    | active，或 000102 之前已归档（原因未知）                    |

- check：值只能是上面三个之一；`archived_reason is null or status = 'archived'`（active 行不能带原因）。
- 状态枚举 `active | archived` **不变**：超限 / 冲突都用 `archived` 表达，所以所有按 `status = 'active'` 过滤的读（结算 owners、快照余额、成交归属、群友买入、广场买入帖、通知、索引器关注地址）无需改动即排除它们。
- 归档行再次被 Privy 报告且不再超限 / 冲突时，恢复 `active` 并清空原因。

## 同步算法（`sync`，单事务）

1. 观察为空且账号仍有 active 行 → 维持原样报错（决策 0033，原逻辑）。
2. 对本次观察到的外部地址按字典序逐个取 `pg_advisory_xact_lock(hashtext('account_wallets.address:' || address))`，串行化两个账号同时认领同一地址；固定顺序避免互等。
3. 记下同步前已 active 的外部地址（「已占位」集合）。
4. 查出被**其他账号**以 active 持有的观察地址（只查外部钱包；内置钱包由 Privy 管理密钥，不做冲突判断）。
5. 逐个 upsert：冲突的写 `archived / address_conflict / is_active=false`；其余写 `active`、清空原因。
6. 没观察到的 active 行 → `archived / unlinked`（原逻辑 + 原因）。
7. **上限**：本账号 active 外部钱包按「同步前已占位优先 → `first_seen_at` 升序 → `wallet_id`」排序，第 4 个起 → `archived / external_limit_exceeded`。
8. 没有当前钱包时按原规则补选（最早的 active 钱包，内置优先）。
9. 提交后对本次的冲突行回调 `onAddressConflict`，服务层记 warn（`reasonCode = WALLET_ADDRESS_OWNED_BY_OTHER_ACCOUNT`）。

### 上限策略说明

裁决原文是「按 `first_seen_at` 保留最早 3 个」。实现加了一条前置：**同步前已经在算的钱包先保留**。原因：`first_seen_at` 在解绑后不重置，如果只按它排序，用户「解绑 A → 绑 D → 再绑回 A」时，A 会把正在算力的 D 挤掉，D 的算力会在用户没操作 D 的情况下中断。前置条件只影响「重新绑回旧钱包」这一种情况；全新账号、一次绑多个时，仍是按 `first_seen_at` 取最早 3 个。存量数据里若已有 4 个以上 active 外部钱包，第一次同步时它们全在「已占位」集合里，按 `first_seen_at` 保留最早 3 个。

### 降级读（决策 0127）

同步写库失败时，原逻辑会在「库里已有的清单与 Privy 观察一致」时返回库里的清单。0185 起，被本规则故意归档的观察钱包（`external_limit_exceeded` / `address_conflict`）也算一致，否则一个有 4 个外部钱包的账号在写库失败时会一直 503。

## 接口

### `POST /v2/wallets/sync`（新）

- 鉴权同 `GET /v2/wallets`；无 body、无 query、拒绝 `Idempotency-Key`（与 `PUT /v2/wallets/active` 同一套写请求头校验）。
- 立即重读 Privy（不走 `GET /v2/wallets` 的 60 秒复用窗口，也不搭车在途的普通读取）；同一用户并发的多次 sync 共用一次 Privy 读取。读到的结果写入复用缓存，并且旧读取晚到时不会覆盖新结果，所以紧接着的 `GET /v2/wallets` 也能看到新清单。
- 幂等：重复调用只是重读 Privy 并收敛到同一清单。
- Privy 不可达 → 503 `PROVIDER_DISCONNECTED`，不写库。
- 响应 = `GET /v2/wallets` 的形状 **总是**带可选键：

```json
{
  "wallets": [
    {
      "walletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      "provider": "privy",
      "address": "0x00000000000000000000000000000000000000a1",
      "kind": "embedded",
      "status": "active",
      "isActive": true,
      "firstSeenAt": "2026-10-25T08:00:00.000Z",
      "lastSeenAt": "2026-10-25T13:00:00.000Z"
    },
    {
      "walletId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "provider": "privy",
      "address": "0x00000000000000000000000000000000000000e4",
      "kind": "external",
      "status": "archived",
      "isActive": false,
      "firstSeenAt": "2026-10-25T12:00:00.000Z",
      "lastSeenAt": "2026-10-25T13:00:00.000Z",
      "archivedReason": "external_limit_exceeded"
    }
  ],
  "activeWalletId": "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  "source": { "provider": "privy", "observedAt": "2026-10-25T13:00:00.000Z" },
  "externalWalletLimit": 3,
  "contractVersion": "2.0"
}
```

### 可选键（遵守「新增键客户端先行」）

| 键                         | 位置       | 类型                                                          | 何时出现                                                                                                  |
| -------------------------- | ---------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `externalWalletLimit`      | 钱包清单根 | integer（当前 3）                                             | `POST /v2/wallets/sync` 总是；`GET /v2/wallets`、`PUT /v2/wallets/active` 仅 `WALLET_LINK_POLICY_EMIT=on` |
| `wallets[].archivedReason` | 每个钱包   | `unlinked` \| `external_limit_exceeded` \| `address_conflict` | 同上，且只在 `status = archived` 且原因已知时出现                                                         |

- 现有键一个都没改：`status` 仍只有 `active | archived`，超限 / 冲突的钱包对旧客户端就是普通的「已归档」。
- 现网客户端的钱包清单解码器是严格键集（`strictMap`），所以 `GET` / `PUT` 的新键挂在 `WALLET_LINK_POLICY_EMIT` 后面，默认 off 时字节不变；新接口只有新客户端会调，直接带键。
- 未放进 `/v2/meta/client-policy`：那份投影同样是严格键集且按配置版本发布，钱包清单是更贴近的位置。

## 暴露面检查（裁决 4）

检查方法：对 `openapi/loop-api.v2.json` 所有 2xx 响应遍历含 `address / wallet / txHash / buyer / holder / trader / sender / recipient` 的字段，并逐个核对查询 `account_wallets` 的仓储（`src/database/*`）。结论分三类：

**A. 只给本人看的（不受开关影响）**

- `GET /v2/wallets`、`PUT /v2/wallets/active`、`POST /v2/wallets/sync`、`/v2/wallets/{id}/balances|activity|receive|networth/history`、钱包意图 / 授权 / 兑换报价、测试网水龙头、`/v2/web/*` 网页注册（本人的钱包地址）。

**B. 对外露出「地址 + LOOP 账号」的（开关覆盖）**

| 接口                                                                                                                       | 露出方式                                                                | 开关关（默认）时                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| launch2 成交与动态（决策 0162 的 `account` 键：实例成交、官方池最近成交、launch2 总览动态）                                | 行里是链上 `wallet` 地址 + `account`（头像 / 昵称 / 公开资料 ID）       | 地址只通过**内置**钱包映射账号；只通过外部钱包对应的地址 `account = null`，与非 LOOP 用户的成交一样只显示地址 |
| `GET /v2/meme/tokens/{id}/trades`、`/holders`（`wallet` + `account`）；`GET /v2/meme/best-trades`（账号 + 收益，不含地址） | 同上（`accountJoin`）                                                   | 同上                                                                                                          |
| `GET /v2/profiles/{id}/holdings`、`/trades`                                                                                | 不返回地址，但读的是对方「当前选中钱包」，成交带 `txHash`，可反查出地址 | 他人查看时改读对方的**内置**钱包（选中的是内置就用它，否则最早的 active 内置钱包）；本人查看仍读选中钱包      |

实现：`createPostgresWalletAccountLookup` / `createPostgresMemeRepository` 的映射查询加 `kind = 'embedded'`（开关开时去掉）；`getActiveWallet(ownerUserId, { embeddedOnly })` 由公开资料服务按「非本人 且 开关关」传入。开关只决定「LOOP 是否把这个地址和账号放在一起」，链上地址本身是公开事实（成交行的 `wallet` 是池子事件里的地址，任何人都能在链上看到），不做替换或伪造。

**C. 未加开关的（无地址，或只有间接线索）**

- `GET /v2/launch2/instances/{id}/dynamic-pool` 的 `currentRoundBuyers[].address`：只有链上地址，没有账号，不构成关联。
- 广场系统帖（买入 / 领取，带 `transactionHash` 和作者）、社区群友买入消息、通知：不含地址，但 `transactionHash` 可在链上反查到买入地址。若需求方要求连这种间接关联也去掉，需另开批次（这些路径的成员解析加 `kind = 'embedded'` 即可，但会让外部钱包的买入不再出现在群友买入 / 广场里）。
- 社区成员列表、挖矿排行、搜索、社交、公开资料主页本身：不含地址。

## 开关

| env                              | 取值              | 默认    | 作用                                                                                        |
| -------------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------- |
| `WALLET_LINK_POLICY_EMIT`        | `off` \| `on`     | `off`   | `GET /v2/wallets`、`PUT /v2/wallets/active` 是否带 `externalWalletLimit` / `archivedReason` |
| `EXTERNAL_WALLET_ADDRESS_PUBLIC` | `true` \| `false` | `false` | 见「暴露面检查」B 类                                                                        |

两者都只在 API 进程读取（worker 不服务这些读）。其他值拒绝启动。

## 测试

- 集成（`test/external-wallet-link-limits.integration.test.ts`，6 例）：上限 3 且内置不计、幂等；解绑腾位、重新绑回旧钱包不挤掉在算的钱包、再解绑后恢复并清空原因；同址冲突写 `address_conflict` 并回调、旧账号解绑后新账号接手；check 约束；快照输入在解绑 / 超限后立即不计；开关关时地址映射只走内置钱包、`getActiveWallet({ embeddedOnly })`。
- 集成（`test/mining-settlement.integration.test.ts` 新增 1 例）：同一结算小时里，解绑后外部钱包不再是 owner；再次绑定撞上他人 active 地址时是 `address_conflict`，owner 仍只有原账号。
- 集成（`test/meme-best-trades.integration.test.ts` 新增断言）：成交钱包改成外部钱包后，默认不再映射到账号（周最佳交易里消失），`externalWalletAddressPublic: true` 时恢复。
- 夹具调整：`meme-best-trades` / `meme-launchpad` / `profile-communities-launch2` / `referral-invite-center` 四个集成套件原先用「外部钱包」代表一个普通 LOOP 交易者，0185 默认下外部钱包不再对外映射，改为带 `provider_wallet_id` 的内置钱包，断言不变。
- 单元：路由 `POST /v2/wallets/sync`（绕过复用窗口、总带新键、幂等、拒绝 Idempotency-Key / body、Privy 不可达 503、要求 bearer）；`GET` / `PUT` 在开关 unset / off 时键集与之前完全相同、on 时带新键；配置解析；公开资料按本人 / 他人 / 开关传 `embeddedOnly`。

## 跟进

- **loop-mobile**：
  1. 钱包清单解码器（`loop_v2_wallet_api.dart` 的 `_directoryKeys` 与每行键集）加入可选键 `externalWalletLimit`（int）与 `archivedReason`（三值枚举，未知值按「已归档」处理），发版后再开 `WALLET_LINK_POLICY_EMIT=on`。
  2. `siwe.link` / `siwe.unlink` 成功后调 `POST /v2/wallets/sync`（同 `PUT /v2/wallets/active` 的请求头，不带 Idempotency-Key、不带 body），用响应刷新钱包清单。
  3. 绑定前用 `externalWalletLimit` 与清单里 `kind = external && status = active` 的数量判断是否已满；同步后若新钱包是 `external_limit_exceeded` / `address_conflict`，提示「已达上限，请先解绑一个」/「该钱包已绑定在另一账号，请先在原账号解绑」。`status = archived` 的钱包不能被选为当前钱包（原规则）。
- **部署**：迁移 000102 在 000101 之后执行；两个开关保持默认即可上线。
- 已知限制：裁决 3 的「先在旧账号解绑」要求旧账号在 Privy 解绑后**同步一次**（App 解绑后自动调 sync）。若旧账号解绑后从未同步，新账号会一直看到 `address_conflict`，直到旧账号下次打开钱包页或调用 sync。
