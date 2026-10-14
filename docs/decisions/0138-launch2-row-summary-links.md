# 0138 · launch2 实例行带项目简介与链接（S180-api，2026-10-14）

依据：主代理 S180 任务单（2026-10-14）：App 发射台 banner 与 NFT 铸造页需要项目简介。
范围：只在 `loop-api`。不新增 env、不新增迁移、不改 worker lane。

## 1. 契约

`GET /v2/launch2/instances` 的每一行与 `GET /v2/launch2/instances/{instanceId}` 的 `instance`（两者共用摘要字段）新增两个**必有**字段：

```
summary: string | null   // 1..61 个 Unicode 字符
links: string[]          // 0..5 条
```

- `summary`：项目资料 `description` 折叠连续空白为一个空格、去首尾空白后，取前 60 个 Unicode 码点；超出则去掉切口处的尾随空白并追加 `…`。为空 → `null`。
- `links`：项目资料 `links` 按保存顺序原样返回，只保留 `http:` / `https:` 且可解析、长度 ≤ 2048 的 URL，过滤后取前 5 条。
- 读不到项目资料（孤儿实例、legacy、配置行缺失或 JSON 异常）→ `summary: null, links: []`，不报错。

## 2. 数据源

`launch2_instances (project_id, config_version)` → `hooks_launch_project_config_versions.config ->> description / -> links`，即实例部署时审核通过并上链的那一版配置（不是创作者之后的草稿）。

实现为 `instanceColumns` 里的一个相关子查询，命中 `(project_id, config_version)` 主键，随列表 / 详情同一条 SQL 读出：没有逐行的额外往返（无 N+1）。投影逻辑在 `src/features/launch2/launch2-project-profile.ts`（纯函数，单测覆盖）。

## 3. 兼容

旧 App 忽略新字段；新 App 对字段缺失也容忍，但本版本起服务端一律返回。OpenAPI v2 产物已重生成。
