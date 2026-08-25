# auth/ — authentication

English | [中文](README.zh.md)

Account authentication for deployments that need it. Nothing in this group is mounted by default; the opt-in bundle lives in [`packages/bundle/auth-bundle`](../bundle/auth-bundle/README.md).

| Package | Role | ctx key |
|---|---|---|
| [`auth/`](auth/README.md) | Authentication Service Definition: account vocabulary, credential login, token resolution, and the account-management contract | — |
| [`authn-local/`](authn-local/README.md) | Local SQLite provider: scrypt password hashing, hashed sliding-expiry tokens, superadmin seeding, login rate limiting | `authn` |
| [`auth-gate/`](auth-gate/README.md) | HTTP gate: self-contained login and administration pages under `/auth/*`, the session-cookie contract, and the page-navigation redirect | — |
