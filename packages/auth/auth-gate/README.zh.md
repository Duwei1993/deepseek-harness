# @deepseek-ai/dsh-auth-gate

[English](README.md) | 中文

[认证 seam](../auth/README.zh.md)（`ctx.authn`）的 HTTP 执行消费者，以 `inject: ['authn', 'webServer']` 挂载。它提供 `/auth/*` 下自包含的登录页与账户管理页，持有会话 cookie 契约，并把未认证的页面导航重定向到登录页。`/api` 传输层的认证闸门在 [`dsh-client-connection`](../../client/connection/README.zh.md)，它解析同一个 cookie。

## 行为

**路由。** `GET /auth/login` 渲染登录页：凭据表单；当访问者已认证但被标记 `mustChangePassword`（或带 `?force-change=1` 到达——这同时是任何已登录账户的自助改密入口）时渲染强制改密表单。已认证且口令正常的访问者被重定向到 `/`。当播种的 `superadmin` 账户仍未完成首次改密时，页面顶部显示显眼的警示条——web 组合树没有 console logger，播种警告由此变得可见。`POST /auth/login` 经 `ctx.authn.login` 校验凭据并种下会话 cookie；失败一律回答 401 与统一的「invalid username or password」措辞，绝不泄露账户是否存在（限流锁定期回答 429）。`POST /auth/logout` 使 cookie 过期，`POST /auth/change-password` 修改当前账户口令（需要 cookie），`GET /auth/status` 回答 `{ authenticated, user?, mustChangePasswordBootstrap }` 供页面与 SPA 探测。`GET /auth/admin` 仅向 superadmin 提供账户管理页（未登录 302 到登录页，已登录非管理员 403），背后是 `GET`/`POST /auth/admin/users` 与 `POST /auth/admin/users/<name>/reset-password`、`set-disabled` 这组仅 superadmin 的 JSON 端点。

**页面。** 两个页面都是内联样式与脚本的单 HTML 文档，不加载任何外部资源，因此在 SPA dist 构建之前、在任何部署路径下都能渲染。产品文案为中文，与 SPA 一致。

**页面导航闸门。** 一条 `prefix /` 路由恰好只拦截 SPA 入口路径：webserver 的 prefix 语义只把 `/` 匹配到该确切路径，其余路径仍由各自的路由或前端 fallback 应答，不受影响。未认证的 GET 页面导航（`Accept` 含 `text/html`）被 302 到 `/auth/login`；已认证但 `mustChangePassword` 的导航被 302 到 `/auth/login?force-change=1`。被放行的请求由闸门从本服务器的组合 index 路径（配置 `indexPath`，默认 `/index.html`）取回并应答。静态资产、`/api` 以及一切非 `/` 路径从不被拦截。

**Cookie。** 登录种下 `<cookieName>=<token>; HttpOnly; SameSite=Lax; Path=/`，值为 bearer token 明文。刻意不加 `Secure` 属性：默认部署是 loopback HTTP；面向网络的部署应放在 HTTPS 反向代理之后。

## 配置

所有字段均可选：`cookieName`（会话 cookie 名，默认 `dsh_auth`；改名时必须与 `dsh-client-connection` 的 `authCookieName` 保持一致）、`indexPath`（页面闸门为放行导航抓取的未受闸地址，默认 `/index.html`，由前端 fallback 应答）。

## 模型体验

无：闸门位于浏览器与宿主之间的 HTTP 承载层，不注册任何 prompt、工具 schema 或模型可见内容。

#### KV Cache 影响

无；这里没有任何内容进入模型请求。

## 已知限制与暂缓工作

- **`/index.html` 可直接访问**——页面闸门只拥有 `/`；index 路径必须保持可达，闸门才能代理它。SPA 外壳是静态标记、不携带数据；`/api` 与 WebSocket 闸门才是强制边界。
- **无 token 吊销**——登出仅使 cookie 过期，bearer token 在滑动过期前仍然有效；seam 尚无吊销操作（见 logout 处理器中的 TODO）。
- **无会话属主绑定**——任何已认证账户都能看到全部会话；按用户过滤在下一里程碑落地。
- **SPA 不会在 401 时自动跳转**——会话在使用中过期后，页面在刷新前只会看到承载层错误；随 SPA 长连接语义一并后续处理。
- **`mustChangePassword` 只在页面导航上强制**——持被标记账户有效 token 直接调 `/api` 仍会成功，这也是纯 API 客户端完成首次改密的途径。
- **OIDC 与外部身份绑定**——seam 的存储已预留，尚无 provider 实现。
