# @deepseek-ai/dsh-auth

[English](README.md) | 中文

DeepSeek Harness 的认证 Service Definition，挂载为 `ctx.authn`。该 seam 以用户名加口令认证账户、将 bearer token 解析为账户，并暴露账户管理面（`listUsers`/`createUser`/`resetPassword`/`setDisabled`)。本包只声明契约：存储与哈希由 [`@deepseek-ai/dsh-authn-local`](../authn-local/README.zh.md) 等提供方实现，强制消费的环节是 [`@deepseek-ai/dsh-auth-gate`](../auth-gate/README.zh.md)（登录 UI 与页面闸门）和 `dsh-client-connection`(`/api` 401 闸门）。

## 词汇

`AuthUser` 是不含凭据材料的账户记录：带品牌标记的 `UserId`、唯一的 `username`、`displayName`、`role`（`'superadmin' | 'user'`）、可选的 `tenant`，以及两个标志位——`disabled`（阻止登录，并使其已有 token 在解析时失效）与 `mustChangePassword`（本 seam 只携带、不执行）。`AuthLogin` 将账户与新签发的 bearer token 配对；提供方只保存 token 的摘要。失败统一抛出带稳定 `AuthErrorCode` 的 `AuthError`；`AUTH_INVALID_CREDENTIALS` 对「用户名不存在」与「口令错误」刻意共用同一措辞，失败通道永不泄露账户是否存在。

## 组合方式

挂载提供方后，整棵 context 树都可访问 `ctx.authn`。消费方通过 `resolveToken(token)` 解析身份（未知、过期或属于已禁用账户的 token 一律返回 `null`；解析成功会顺延该 token 的过期时间），通过 `login(username, password)` 完成认证。`mustChangePassword` 账户仍能从 `login` 拿到 token；把该标志变成 HTTP 或 UI 闸门属于日后挂载它的消费方。

## 模型体验

无，因为本 seam 只声明抽象服务契约，不注册任何提示词、工具 schema 或模型可见内容。

#### KV Cache 影响

无；此处没有任何内容进入模型请求。

## 已知限制与暂缓工作

- **尚无比对会话属主的绑定**:HTTP 闸门([`dsh-auth-gate`](../auth-gate/README.zh.md)）与 `/api` 401 闸门已强制认证，但还没有任何环节把会话绑定到账户或按属主过滤会话列表；TODO：下一里程碑。
- **尚无 OIDC 提供方**：本 seam 目前仅有口令认证；M3b 提供方将消费本地提供方已存储的 `external_identities` 管线。TODO:M3b。
- **改密不吊销 token**:`changePassword`/`resetPassword` 让已签发的 token 存活至自然过期；TODO：设计吊销策略时一并实现改密吊销。
- **没有登出或 token 枚举**:token 只能过期或随账户禁用而失效；尚未声明显式吊销。
