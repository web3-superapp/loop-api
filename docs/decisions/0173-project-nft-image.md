# 0173 · 项目 NFT 图：上传（IPFS / Filebase）、草稿字段、公开投影与 ERC-721 元数据（S274-api，2026-10-22）

## 1. Status

已实现（分支 `feat/S274-nft-image`，基线 `integration/v2` `7f2f076`）。迁移 `000096_launch2_nft_image`（000095 为 S272 `friend_direct_channel_jobs`，须先于本迁移应用）。新路径 2 条：`POST /v2/media/project-nft-images`、`GET /v2/launch2/nft/{launchId}/{tokenId}`。新 env：`NFT_IMAGE_STORAGE`、`FILEBASE_RPC_ENDPOINT`、`FILEBASE_RPC_TOKEN`、`IPFS_GATEWAY_BASE_URL`、`LAUNCH2_NFT_IMAGE_EMIT`。不改合约。配套：loop-admin `feat/S274-nft-image`（审核页 / 项目详情显示「NFT 图」），App 侧 S275（loop-mobile 决策 0233）。

## 2. Context

- 主代理 2026-10-22 产品裁决：项目方创建项目时上传一张 NFT 图。MEME v2 的 `ProjectNFT`（每实例一个，tokenId 1..n）链上没有 tokenURI，App 目前拿项目 logo 代替。
- 需求方随后裁决：NFT 图存 IPFS（Filebase），不放我们的媒体盘为唯一来源。Filebase IPFS RPC `POST /api/v0/add`（multipart `file`，Bearer token）返回 `{"Name","Hash","Size"}`，网关 `https://ipfs.filebase.io/ipfs/<cid>` 可读（主代理已验证；本批 opt-in 实测再次通过）。
- 草稿已有 `logoAssetUrl`（只校验 https、无凭据，**不**校验归属）；激活时由 `registerActivatedInstances` 拷进 `launch2_instances.logo_url`，再投影为 `logoUrl`。
- 已发布 App 的 V2 解码器严格（决策 0166 §D），既有响应对象的新增键必须默认关闭。

## 3. Decision

### A. 上传：媒体种类 `project_nft_image`

- `POST /v2/media/project-nft-images`，与 `community-logos` 同一套规则（决策 0095）：写头 + UUIDv4 `Idempotency-Key`、multipart 单 part `file`、按内容识别 JPEG/PNG/WebP/HEIC、≤ 5 MiB、两边 ≥ 64 px、存 512×512 cover WebP（去元数据）、两条旧上传路由共用每人每分钟 6 次。建议方图，不强制比例。
- `NFT_IMAGE_STORAGE=filebase`：处理后的 WebP（即 `/v2/media` 实际下发的字节）先 pin 到 IPFS，再入库；`media_objects.ipfs_cid` 在插入时写入（行不可变，000046 触发器）。pin 失败 → `503 CAPABILITY_UNAVAILABLE / MEDIA_IPFS_UNAVAILABLE`，不入库（同 key 重试即可；同字节 CID 相同，孤儿 pin 无害）。幂等重放不再 pin。`local`（默认）：不 pin，`cid = null`，与其他媒体一致；测试与本地开发不需要 Filebase。
- 响应 `201 {mediaId, ref: "nft:media/{id}", url, mediaUrl, cid, ipfsUri, width, height, contractVersion}`：`url` = pin 后的网关 URL `<IPFS_GATEWAY_BASE_URL>/<cid>`，未 pin 时为 API 相对路径 `/v2/media/{id}.webp`（同 logo）；`mediaUrl` 恒为本地副本路径（回退）；`ipfsUri` = `ipfs://<cid>`。
- Pinner：`src/features/media/ipfs-pinner.ts`，用 Node 自带 `fetch` + `FormData`，不引入 AWS SDK；超时 10 s；token 只出现在 `Authorization` 头，不进日志 / 错误消息 / 响应。不使用 Filebase S3 凭据（`FILEBASE_S3_*`、`FILEBASE_BUCKET`、`FILEBASE_ACCESS_KEY_ID`、`FILEBASE_SECRET_ACCESS_KEY` 本批不读取）。

### B. 草稿字段 `nftImageAssetUrl`

- `PUT /v2/launch/projects/{projectId}/hooks-config` 的 `config` 新增**可选**键 `nftImageAssetUrl`（请求 schema `additionalProperties: false`，显式加入）；旧草稿没有它。值 = 上传返回的 `url`（相对路径须由客户端补成绝对 https），或 `<PUBLIC_BASE_URL>/v2/media/<mediaId>.webp`。
- 服务端解析到媒体行：必须是**调用者本人**的 `project_nft_image`（网关 URL 按 (owner, cid) 查，媒体 URL 按 mediaId 查），其他 URL / 他人上传 / 其他种类 → `422 VALIDATION_FAILED / MEDIA_NOT_OWNED`。比 logo 严格（logo 维持原规则不变）。
- 入库为规范形式：pin 过的图一律存网关 URL，另存服务端派生的 `nftImageCid`（不可由客户端提交；带它的请求 400）。`GET …/hooks-config` 回显 `nftImageAssetUrl`（可选键），**不**回显 `nftImageCid`（App 的 config 解码器只容许 `poolHookKind`、`nftImageAssetUrl` 两个可选键）。
- configHash：无该键时编码与之前逐字节相同（金样本 `0x9b16…b948` 不变）；有该键时在签名元组末尾追加 `string nftImageAssetUrl`（`…, bytes32 fixedEconomicsHash, string nftImageAssetUrl`），项目方签的就是这张图。CID 已在网关 URL 里，不单独入哈希。
- 每次保存是整份 config：不带该键即清除。运营改配置（`launch.config.save`）同样只接受项目方本人的上传（否则 `OPS_INVALID_LAUNCH_CONFIG`），保留规范 URL + CID。
- 数据库：`hooks_launch_config_object` 约束放行两个可选键（`nftImageAssetUrl` https 且 ≤ 2048；`nftImageCid` 合法 CID 且只能与前者同在）。

### C. 读模型与公开投影

- `launch2_instances.nft_image_url` / `nft_image_cid`：激活投影从签名 config 拷贝（带长度 / CID 正则保护，坏值置 null，绝不让整批插入失败）；迁移对已有行按 config 回填（目前为空操作）。
- `nftImageUrl`（可选、可空）：实例列表行、实例详情、`GET /v2/launch2/me/positions` 行。值 = `nft_image_url`（pin 时即网关 URL），无图为 `null`，客户端回退 `logoUrl`。**只在 `LAUNCH2_NFT_IMAGE_EMIT=on` 时下发**（默认 `off` 不带键），schema 中不在 `required`，永远不改为必带。
- 控制台：`GET /admin/v1/launch/projects/{projectId}` 的 `versions[].config` 恒带 `nftImageAssetUrl`、`nftImageCid`（无则 null）。

### D. ERC-721 元数据 `GET /v2/launch2/nft/{launchId}/{tokenId}`

- **路径稳定**：这是将来主网工厂链上 `_baseURI` 的目标，`tokenURI = <PUBLIC_BASE_URL>/v2/launch2/nft/<launchId>/<tokenId>`。路径、参数形状、键名不得更改。
- 公开资源，同 logo 代理：无 Bearer、无 LOOP 头、不收 query；`Cache-Control: public, max-age=300, stale-while-revalidate=3600`（stage 会变），`Access-Control-Allow-Origin: *`；错误 `no-store`。
- 体：`{name: "<项目名> #<tokenId>", description: 项目简介（空则固定句 "A project NFT of a MEME v2 launch on LOOP."）, image, image_gateway, attributes: [{trait_type:"Project", value: ticker}, {trait_type:"Token ID", value: tokenId（整数）}, {trait_type:"Stage", value: stage}]}`。`image` = 有 CID 时 `ipfs://<cid>`，否则 NFT 图 URL，否则 logo，否则 null；`image_gateway` = 同一张图的 https 形式（网关 URL / NFT 图 URL / logo / null）。不出 `external_url`（目前没有公开项目页 URL，将来有了再加为新键）。
- `launchId` = `0x` + 64 hex（大小写均可）；`tokenId` = 正十进制、无前导零。格式错 → 400 `INVALID_REQUEST`；未知或未激活实例 → `404 NOT_FOUND / LAUNCH2_INSTANCE_NOT_FOUND`；`tokenId > nft_minted_count` → `404 NOT_FOUND / LAUNCH2_NFT_NOT_MINTED`。随 `launch2` 模块注册，依赖缺失时 503 同其他 launch2 路由。

### E. 环境变量（staging / prod 由主代理接线）

| 变量                     | 默认                            | 说明                                                     |
| ------------------------ | ------------------------------- | -------------------------------------------------------- |
| `NFT_IMAGE_STORAGE`      | `local`                         | `local` / `filebase`，其他值拒绝启动                     |
| `FILEBASE_RPC_ENDPOINT`  | —                               | `filebase` 时必填，https（如 `https://rpc.filebase.io`） |
| `FILEBASE_RPC_TOKEN`     | —                               | `filebase` 时必填，**机密**，只放未入库的 env 文件       |
| `IPFS_GATEWAY_BASE_URL`  | `https://ipfs.filebase.io/ipfs` | https、无 query                                          |
| `LAUNCH2_NFT_IMAGE_EMIT` | `off`                           | `off` / `on`，控制 `nftImageUrl` 下发                    |

需在 `ops/api-prod.env.example`、staging env 等仓库外文件登记以上变量（本批只改 loop-api `.env.example`）。

### F. 发布顺序

1. 先上线本批服务端（迁移 000096 在 000095 之后）。**带 S275 的 App 只能对接已含 S274 的服务器**（旧服务器没有上传路由，且草稿 schema 会以 400 拒绝 `nftImageAssetUrl`）。
2. staging / prod 配置 `NFT_IMAGE_STORAGE=filebase` + Filebase RPC 变量后，上传才会进 IPFS；未配置时照常本地存储、`cid` 为 null。
3. 所有仍受支持的 App 版本都能解码 `nftImageUrl` 后，再把 `LAUNCH2_NFT_IMAGE_EMIT` 切到 `on`。
4. 主网工厂接线 `_baseURI` 时指向 §D 路径；本批不改合约。

## 4. Consequences

- 旧项目没有 NFT 图：投影 `null`，元数据回退 logo。
- 回滚：000096 `down` 在存在 `project_nft_image` 媒体或带 NFT 图的 config 时拒绝执行。
- 证据：`test/launch2-nft-image.test.ts`（草稿哈希逐字节不变 / 追加编码 / 规则、元数据纯函数、三处投影 off / on、元数据路由 200 / 404 / 400 与缓存头、项目方保存解析）、`test/v2-media-routes.test.ts`（本地 / pin / pin 失败 503 / 其他种类不 pin / 归属解析）、`test/ipfs-pinner.test.ts`（RPC 形状与失败闭合；opt-in 实连 Filebase，env 缺失时跳过）、`test/config.test.ts`、`test/launch2-nft-image.integration.test.ts`（真实 PostgreSQL：CID 约束、不可变、项目方 / 运营保存、控制台载荷、读模型列、激活投影 SQL）。
