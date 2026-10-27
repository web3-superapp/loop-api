# 0188 社区榜行可选键 avatarRef

- 日期：2026-10-27（S316a）
- 状态：已采纳

## 决定

- `GET /v2/mining/rank?scope=communities` 的每个 `ranking.items[]` 行新增**可选键** `avatarRef`。
- 来源：`public.communities.logo_ref`，与社区资源的 `logoRef` 同源同格式：`avatar:preset/community-NN`（01–12）或 `logo:media/{uuid v4}`。
- null 规则：`logo_ref` 为空，或不匹配 `communityLogoRefPatternSource` → 输出 `null`；不 fail、不回退其它图。
- 只作用于 communities 行；users / referrals 行不变；不涉及迁移，不改排序与游标。
- 客户端已在 S315 用可选键先行解析（遵循「/v2 新增键客户端先行」），客户端不得把该键当必需。

## 范围外

- 算力名单外部代币、`includedAssets` 等 S316 其余改动另立决策（编号顺延）。
