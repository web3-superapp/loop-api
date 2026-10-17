# 0157 · 公开媒体图片允许跨源嵌入（S225-api，2026-10-17）

## 1. Status

已实现（分支 `fix/S225-public-page`，基线 `d9b8fb2`）。无迁移、无 SQL 变化，未改 `ops/*.env`。OpenAPI 只改了 `GET /v2/media/{mediaId}.webp` 的描述文字。

## 2. Context

缺陷 D11：公开 MEME 网页（`https://loop-meme.vercel.app`，决策 0147）对 S221W 显示占位字母「S」，App 里同一项目有 Logo。

排查：

- `GET /public/v1/meme` 与 `/public/v1/meme/{id}` 都返回了 `logoUrl = https://api-staging.quant-dinger.cc/v2/media/<id>.webp`，URL 可访问（200 image/webp）。
- 页面 `logoHtml` 用 `<img src=logoUrl>`，失败时 `onerror` 回落成首字母。
- 响应头带 `Cross-Origin-Resource-Policy: same-origin`——来自 `app.register(helmet)` 的全局默认。浏览器据此拒绝其他站点（vercel.app）以 no-cors 方式加载该图片，`onerror` 触发，于是显示「S」。App 是原生网络栈，不执行 CORP，所以正常。

## 3. Decision

`GET /v2/media/:mediaId.webp`（200 与 304）显式设置 `Cross-Origin-Resource-Policy: cross-origin`。

理由：该资源本来就是公开、不可变、无鉴权的图片（决策 0095），允许任何源嵌入不扩大暴露面；其余路由继续保留 helmet 的 `same-origin` 默认。不加 CORS 头（页面用 `<img>`，不需要读字节）。

## 4. Consequences

- 公开页、后台或任何第三方网页都能直接显示用户上传的头像 / 社区 Logo / MEME Logo。
- 需部署 API 后线上公开页的 Logo 才会恢复；页面本身无需改动。
- 测试：`test/v2-media-routes.test.ts` 断言 200 与 304 都带该头。
