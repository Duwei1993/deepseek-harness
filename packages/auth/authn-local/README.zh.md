# @deepseek-ai/dsh-authn-local

[English](README.md) | 中文

[认证 seam](../auth/README.zh.md)(`ctx.authn`）的本地提供方。账户存放在 harness home（`$DSH_HOME` > `~/.dsh`）下的 `auth.db`（基于 `node:sqlite`)，模式由单调递增的 `PRAGMA user_version` 迁移梯（`SCHEMA_VERSION`，当前为 1）管理：`users`（用户名唯一、角色检查、`must_change_password`/`disabled` 标志位）、`external_identities`(`UNIQUE(provider, subject)` 绑定，为 M3b OIDC 提供方预留）、`auth_tokens`（以 token 摘要为键）。插件卸载时通过其 fiber 的 disposer 关闭数据库。

## 行为

口令用 scrypt 加 32 字节随机盐哈希，以 `saltHex:hashHex` 形式存储，校验时使用恒定时间比较。对不存在用户名的登录会针对一个固定的替身哈希做校验，使失败耗时与口令错误一致；两者都以统一的 `AUTH_INVALID_CREDENTIALS` 措辞失败。bearer token 是 32 字节随机数的 base64url 编码；只存储其 SHA-256 摘要。token 自签发起存活 `tokenTtlMs`（默认 7 天），每次 `resolveToken` 成功都会把过期时间顺延同样的时长；发现已过期 token 时随即删除。同一用户名连续登录失败会触发内存中的指数退避锁定（`rateLimitBaseDelayMs` 逐次翻倍，上限 `rateLimitMaxDelayMs`，默认 1 秒至 5 分钟）；凭据校验成功会清零连败计数。

对空库首次启动时会播种 `superadmin` 账户（`mustChangePassword: true`）并输出醒目的告警日志。未配置 `seedSuperadminPassword` 时，种子口令是众所周知的默认值 `123456`，告警会点名它——请立即更换。播种以 `users` 表为空为前提，因此之后的启动与重新挂载不会改动任何内容。

## 配置

所有字段均可选：`path`（数据库文件，或 `:memory:`；默认 harness home)、`seedSuperadminPassword`（仅在库为空时生效的测试钩子）、`tokenTtlMs`、`rateLimitBaseDelayMs`、`rateLimitMaxDelayMs`。测试还可以通过服务的 `internals.now` 钩子控制时间。

## 模型体验

无，因为该提供方只通过 `ctx.authn` 服务同进程调用方；它存储或返回的任何内容都不会进入模型请求。

#### KV Cache 影响

无；此处没有任何内容进入模型请求。

## 已知限制与暂缓工作

- **seam 不做会话属主绑定**:HTTP 闸门已消费 `ctx.authn` 做认证，但会话列表对所有账户共享；TODO：下一里程碑。
- **`external_identities` 目前只是存储**：在 M3b OIDC 提供方到来之前，没有任何服务方法链接或解析外部身份；只有 store 层会用到它。
- **限流是进程本地的**：连败计数保存在内存中，重启即重置；多实例部署需要共享的限流器。
- **token 清理是惰性的**：过期 token 只在被解析时删除，没有定期清扫。
- **`node:sqlite` 会在每个进程发出一次 Node 22 的 ExperimentalWarning**：提供方在挂载时才惰性导入它；尚未复刻 `dsh-session-persistence-sqlite` 的告警过滤处理。
