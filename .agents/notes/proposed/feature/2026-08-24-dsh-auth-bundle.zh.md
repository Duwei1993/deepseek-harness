# Agent Note: dsh-auth bundle — 认证能力骨架（M3a）

Status: proposed

[English](2026-08-24-dsh-auth-bundle.md) | 中文

## Problem

DeepSeek Harness 的 HTTP 面（apiproxy/webserver）没有用户概念：任何能连上端口的调用方都能列出、打开并驱动所有会话。多用户部署需要账户体系——认证身份、凭据登录、bearer token 与管理面——然后才谈得上路由闸门与会话属主。

这个能力必须分阶段落地。HTTP 闸门、会话属主绑定与登录 UI 都要求账户模型与 token 机制先存在并有测试钉住；把它们和底层存储放在同一个变更里会无法评审。第一阶段交付了骨架：seam 契约、一个具备完整领域逻辑的本地提供方、可选启用的 bundle 与单测。第二阶段（本次更新）交付执行的一半：HTTP 闸门及其自包含登录与管理页、`/api` 401 闸门、页面导航重定向——会话属主绑定仍不在内。

## Proposal

`packages/auth/` 组按能力 seam 切分，外加一个 bundle：

- **`packages/auth/auth`（`@deepseek-ai/dsh-auth`）**——Service Definition，挂载为 `ctx.authn`。`AuthUser` 携带带品牌标记的 `UserId`（`dsh-brand`）、`username`、`displayName`、`role: 'superadmin' | 'user'`、可选 `tenant`，以及 `disabled` / `mustChangePassword` 标志位。抽象 `AuthnService` 声明 `resolveToken`（未知、过期或属于已禁用账户的 token 一律返回 `null`；解析成功顺延过期）、`login`、`changePassword` 与管理面 `listUsers`/`createUser`/`resetPassword`/`setDisabled`。失败携带带稳定错误码的 `AuthError`；`AUTH_INVALID_CREDENTIALS` 对「用户名不存在」与「口令错误」共用同一措辞，失败通道永不泄露账户是否存在。
- **`packages/auth/authn-local`（`@deepseek-ai/dsh-authn-local`）**——本地提供方。`node:sqlite` 存于 harness home（`dshHomePath`）下的 `auth.db`，模式由单调递增的 `PRAGMA user_version` 迁移梯管理（`SCHEMA_VERSION = 1`）：`users`、`external_identities`（`UNIQUE(provider, subject)`，为 M3b OIDC 预留的纯存储管线）、以 SHA-256 摘要为键的 `auth_tokens`。口令用随机盐 scrypt，以 `saltHex:hashHex` 存储，`timingSafeEqual` 校验；不存在的用户名会对固定替身哈希校验，使失败耗时与口令错误一致。token 为 32 字节随机数，默认存活 `tokenTtlMs`（7 天），每次解析成功顺延；发现过期即删。登录失败按内存指数退避锁定用户名（1 秒起步翻倍至 5 分钟上限，两者均为 Config 字段）；凭据成功清零连败。库为空时播种 `superadmin` / `123456`（`mustChangePassword: true`）并输出醒目的 `ctx.logger.warn` 横幅；`seedSuperadminPassword` 是文档化的测试钩子，仅在库为空时生效。数据库随插件 fiber 的 disposer 关闭。
- **`packages/auth/auth-gate`（`@deepseek-ai/dsh-auth-gate`）**——HTTP 执行消费者，`inject: ['authn', 'webServer']`。提供自包含页面（内联 CSS/JS、无外部资源、与 SPA 一致的中文产品文案）：`GET /auth/login` 渲染凭据表单，对已认证但被标记 `mustChangePassword` 的账户渲染强制改密表单（任何已登录账户也可经 `?force-change=1` 自助改密）；当播种的 superadmin 仍未完成首次改密时页面携带警示条——这是播种警告的可见落点，因为 web 组合树没有 console logger 承接 `logger.warn`。JSON 端点：`POST /auth/login`（种下会话 cookie `<cookieName>=<token>; HttpOnly; SameSite=Lax; Path=/`，刻意不加 `Secure`——loopback 是默认场景，对外部署应走 HTTPS 反代）、`POST /auth/logout`（使 cookie 过期；seam 尚无吊销——TODO）、`POST /auth/change-password`（需要 cookie）、`GET /auth/status`（`{ authenticated, user?, mustChangePasswordBootstrap }`，供页面与 SPA 探测），以及仅 superadmin 的管理面 `GET /auth/admin` 加 `GET`/`POST /auth/admin/users`、`POST /auth/admin/users/<name>/reset-password`、`POST /auth/admin/users/<name>/set-disabled`。
- **页面导航闸门**——一条 `prefix /` 路由恰好只拦截 SPA 入口路径：webserver 的 prefix 语义匹配 `p` 或 `p/<anything>`，而 `/` 没有子路径形态，因此该注册只拥有 `/`，其余路径仍由各自路由或前端 fallback 应答。未认证的 GET 页面导航（`Accept` 含 `text/html`）302 到 `/auth/login`；`mustChangePassword` 的 302 到 `/auth/login?force-change=1`。被放行的请求由闸门从组合的 index 路径（`indexPath` 配置，默认 `/index.html`）回本服务器取响应，因为 webserver 中已匹配的路由拥有整个响应、无法交还 fallback。
- **`packages/bundle/auth-bundle`（`@deepseek-ai/dsh-auth-bundle`）**——可选启用的 bundle：一个 `cordis.patch.yml` 插入列表挂载 `authn-local` 与 `auth-gate`，两行都可从 bundle 自身依赖解析。就绪顺序由 inject 驱动：闸门声明 `inject: ['authn', 'webServer']`，因此它在提供方之后激活，且只在携带 web 服务器的组合中出现。

**`/api` 闸门是对 `packages/client/connection` 的最小修改，而不是新包**：`/api` 前缀路由与升级路由由 connection 插件拥有，任何其他包都无法拦它们。当 `ctx.get('authn')` 找到这个可选服务时，路由处理器在信任 fence 之后解析会话 cookie，并在桥接之前以 401 JSON 应答——这个位置同时覆盖绕过 fetch fallback 的 Typert Remote interceptor。同一 cookie 检查在协商前以 401 拒绝未认证的 WebSocket 升级。`PRIVILEGED_METHODS` 的回环钉死放宽为「回环或 superadmin」：fallback 的特权检查从桥接创建的 `Request` 重新解析 cookie，放行来自任何受信权威的已认证 `role === 'superadmin'`；回环上的任何已认证账户照常可达；没有 `authn` 服务时行为与认证前逐字节一致。cookie 名是共享配置：闸门的 `cookieName` 与 connection 的 `authCookieName` 都默认 `dsh_auth`，改名必须两侧同步。

包目录是 `packages/bundle/auth-bundle` 而不是同名短目录：tsconfig 源平面通配按目录名映射 `@deepseek-ai/dsh-<dir>`，名为 `auth` 的 bundle 目录会遮蔽 `dsh-auth` 包说明符。

仍明确不做：会话属主绑定与列表过滤、OIDC 提供方（M3b）、token 吊销、SPA 内 401 自动跳转登录页（随长连接重连语义一并后续）。seam 不挂载任何模型可见面，因此不欠快照 fixture；行为由针对临时目录数据库的单测加一套真实 Loader 组合测试（经活 HTTP 驱动闸门）钉住，绝不触碰真实 harness home。

## Alternatives considered

**跳过 Service Definition 直接挂载具体存储。** 否决：HTTP 闸门与 OIDC 提供方（M3b）都以 seam 为目标；没有抽象契约，日后替换提供方就要改动每个消费方，这正是能力 seam 规则所禁止的。

**用 JWT bearer token 而非不透明摘要。** 本骨架否决：无状态 token 没有吊销列表就无法随 `disabled` 或过期顺延失效，而这又把 JWT 本想省掉的存储请了回来。不透明 token 把吊销语义收在一张表里。

**用 Argon2 或 bcrypt 做口令哈希。** 否决：`node:crypto` 的 scrypt 随运行时提供、无需新依赖；`salt:hash` 记录格式让算法可替换而无需模式变更。

**把播种推迟到首次登录尝试而非首次启动。** 否决：启动时播种在库创建的同一时刻明确地失败并告警一次；惰性播种会把默认凭据警告埋进某个不相干的请求里。

**把认证库并入会话 SQLite 存储。** 否决：会话与账户的生命周期、备份姿态与所有权不同；一域一库让各存储的模式迁移梯相互独立。

**为页面闸门给 `dsh-host-webserver` 加中间件原语。** 本里程碑否决：webserver 的路由契约（exact > 最长 prefix > fallback，匹配路由拥有响应）对每个既有消费者都是承重的，而闸门只需要拥有 `/`——既有 prefix 语义恰好已能做到。拥有 `/` 并从 fallback 自己的 index 路径代理放行导航，在不改 webserver 的前提下实现了重定向；若后续里程碑确需多路径拦截，再带着证据设计中间件钩子。

**用 index 注入做客户端重定向代替 HTTP 302。** 否决：`webserver/index-inject` 与 `tapIndex` 只见标记、不见请求，无法按会话 cookie 分派；脚本注入的检查会先闪出 SPA 外壳，且仍需要 `/api` 闸门做强制。承载层 302 是在组合已拥有的路由上的一行策略。

**用 `WeakMap<Request, AuthUser>` 把解析出的 `AuthUser` 递给特权检查。** 否决：WHATWG `Request` 由桥接内部构造，路由处理器没有可挂键的对象；在特权检查里重新解析 cookie 是无状态的，多出的那次 `resolveToken` 只是配置面调用上的一次 SQLite 摘要查询。

**把静态资产与 `/index.html` 也纳入闸门。** 否决：SPA 外壳是不携带数据的静态标记，`/api` 与 WebSocket 闸门才是强制边界；页面闸门为 UX 而存在（落在登录页而不是坏掉的外壳），只拥有 `/` 是相称的。该限制记录在闸门 README 中。

## Acceptance criteria

- 各包注册进 host 聚合与 `tsconfig.base.json` 源平面通配；每个包可单独经 `tsc -b packages/<group>/<pkg>` 构建、经 `vitest run packages/<group>/<pkg>` 测试（仓库包没有包级 npm 脚本），根 `typecheck` 通过。
- 单测覆盖口令哈希与恒定时间校验（含畸形记录）、token 签发/解析/滑动过期/过期删除、播种及其跨重挂载幂等、限流退避梯与其上限、管理面、外部身份链接表——全部针对临时目录与注入时钟。
- 闸门的逐文件 100% 覆盖门禁通过：cookie 助手、页面渲染、请求体读取、完整路由矩阵（登录成功/失败/限流、强制改密、status、登出、admin CRUD 及其权限拒绝）与页面闸门重定向/代理——包括一套真实 Loader 组合（webserver + 提供方 + 闸门，走活 HTTP）和一套覆盖提供方崩溃与代理失败的手工边界套件。
- connection 改动钉住两种组合：挂载 `authn` 时，无 cookie 的 `/api` 请求与升级得到 401，superadmin 从受信权威可达特权方法集；未挂载时，全部既有测试逐字保持。
- 各包的 invariant 伴随注册自己的包名；cordis-config、package-invariant、README（Model Experience + 已知限制）与翻译配对门禁通过。
- bundle 的补丁行可从 bundle 清单的依赖解析，挂载该 bundle 能引导出可用的 `ctx.authn` 与闸门。
- 对 `dsh web --port 0 --no-open` 的端到端冒烟展示完整矩阵：未认证导航 302、错误口令 401、登录 cookie、受闸 `/` 200、播种警示条的生命周期、改密、admin 用户管理、`/api` 401。

## Risks

默认种子口令是刻意的首次启动不安全；闸门现在强制在任何页面导航成功之前完成轮换，登录页在其存续期间显示警示条，`/api` 闸门关闭了未认证 RPC 路径——但没有任何默认 profile 携带该 bundle，未启用认证的部署不受影响。

页面闸门只拥有 `/`：`/index.html` 与静态资产未认证即可达，其安全性仅建立在 SPA 外壳不携带数据且传输闸门完整之上——日后任何在 `/` 之外提供敏感 HTML 的路由都必须重审这一点。

闸门的 index 代理为每次放行的 `/` 导航增加一跳 loopback；用户无感，但这意味着闸门依赖组合的 fallback 应答 `indexPath`——没有前端的组合会以 fallback 自己的 404 应答。

进程本地限流与惰性 token 清理是已知的简化；两者都记录为限制，并按该提供方所服务的单进程 harness 规模设定。

seam 契约先于其剩余消费方设计。会话属主绑定仍可能迫使调整（例如 token 内省元数据），后续里程碑须修订本记录以登记。
