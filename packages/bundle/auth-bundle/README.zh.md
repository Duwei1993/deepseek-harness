# @deepseek-ai/dsh-auth-bundle

[English](README.md) | 中文

可选启用的认证 bundle。它的 [`cordis.patch.yml`](cordis.patch.yml)——通过 `dsh.bundle.patch` 清单字段声明——在其叠加的 profile 之上插入两行：`authn-local`，即 [`ctx.authn` seam](../../auth/auth/README.zh.md) 的[本地 SQLite 提供方](../../auth/authn-local/README.zh.md)；以及 `auth-gate`，即提供 `/auth/*` 登录与账户管理页并重定向未认证页面导航的 [HTTP 闸门](../../auth/auth-gate/README.zh.md)。部署方把本 bundle 加进 profile 的 bundles 列表即完成启用；其后的补丁层仍可按 id 覆盖或禁用任一行。

两行默认启用：提供方在启动时打开 harness home 下的 `auth.db`，并在库为空时播种 `superadmin` 账户（默认口令 `123456`，带 `mustChangePassword` 标志，并输出醒目告警）；闸门会强制该账户的首次登录直接进入改密表单。挂载本 bundle 后，`dsh-client-connection` 的可选 `/api` 闸门也随之激活：所有 `/api` 请求与 WebSocket 升级必须携带闸门签发的会话 cookie，且特权方法集从「仅 loopback」放宽为「loopback 或 superadmin」。会话属主绑定在后续里程碑落地（见闸门包的已知限制）。本包自身没有运行时 API。

## 模型体验

间接地，通过被插入的行：本 bundle 只是补丁列表的载体，各行的行为由其所属包负责，且其中没有任何内容进入模型请求。

#### KV Cache 影响

无；被插入的行不注册任何模型可见内容。

## 已知限制与暂缓工作

- **无会话属主绑定**：任何已认证账户都能看到全部会话；按属主过滤是下一里程碑。
- **bundle 固定挂载本地提供方**：想要其他提供方的部署需在后续补丁层禁用 `authn-local` 行并自行挂载；bundle 本身不提供提供方选择配置。
