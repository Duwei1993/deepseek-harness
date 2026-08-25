# auth/ —— 认证

[English](README.md) | 中文

为有需要的部署提供的账户认证。本组默认不挂载任何内容；可选启用的 bundle 在 [`packages/bundle/auth-bundle`](../bundle/auth-bundle/README.zh.md)。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`auth/`](auth/README.zh.md) | 认证 Service Definition：账户词汇、口令登录、token 解析与账户管理契约 | — |
| [`authn-local/`](authn-local/README.zh.md) | 本地 SQLite 提供方：scrypt 口令哈希、摘要存储的滑动过期 token、superadmin 播种、登录限流 | `authn` |
| [`auth-gate/`](auth-gate/README.zh.md) | HTTP 闸门：`/auth/*` 下自包含的登录与管理页、会话 cookie 契约、页面导航重定向 | — |
