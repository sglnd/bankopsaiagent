# BankOps Identity Service

独立的本地身份与权限服务。当前使用 PostgreSQL 本地账号；未来接入 SSO 时替换认证来源，Portal、角色模型和下游签名身份协议保持不变。

## 组织与角色

预置七个团队：综合、技术、安全、云、系统、网络、环境。

- `PLATFORM_ADMIN`：全局用户、团队和角色管理。
- `DEPARTMENT_ADMIN`：只能审批、停用本团队用户，只能授予 `OPERATOR`。
- `OPERATOR`：使用变更分析、系统巡检和只读知识检索。
- `SECURITY_AUDITOR`：预留给身份、操作和模型审计查询。
- `KNOWLEDGE_MANAGER`：上传文档、创建版本、重建与删除索引。
- `SKILL_DEVELOPER`：编辑、校验、发布和回滚用户 Skill。

自助注册用户默认获得 `OPERATOR`，状态为 `PENDING`；管理员批准为 `ACTIVE` 后才可登录。

## 安全边界

- 密码使用带 128-bit 随机盐的 scrypt，数据库不保存明文密码。
- 浏览器会话使用随机不透明令牌；数据库只保存 SHA-256 哈希。
- 会话 Cookie 设置 `HttpOnly`、`SameSite=Lax`，生产 HTTPS 必须设置 `BANKOPS_COOKIE_SECURE=1`。
- Portal 对所有写请求校验双提交 CSRF Token。
- 连续 5 次密码错误锁定 15 分钟；停用账号会立即撤销全部会话。
- Portal 使用 HMAC 签名身份上下文，下游不信任浏览器自报的用户、部门和角色。
- 登录、审批、授权、停用、密码修改和退出写入 `identity_audit_events`。

本地 Compose 中的默认密钥和引导密码只用于单机开发。共享或生产环境必须覆盖：

```dotenv
BANKOPS_IDENTITY_INTERNAL_TOKEN=<至少 24 位随机值>
BANKOPS_IDENTITY_SIGNING_SECRET=<至少 32 位随机值，Portal/Agent/Knowledge 保持一致>
BANKOPS_BOOTSTRAP_ADMIN_PASSWORD=<高强度一次性密码>
BANKOPS_COOKIE_SECURE=1
BANKOPS_IDENTITY_REQUIRED_FOR_REST=1
```

引导管理员只在用户名不存在时创建，不会在容器重启时重置密码。

## 接口

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/change-password`
- `GET /api/v1/auth/departments`
- `GET /api/v1/admin/users`
- `PATCH /api/v1/admin/users/:userId`
- `GET /api/v1/admin/roles`

`/internal/v1/session` 只供 Portal 使用，必须携带内部服务令牌。

## SSO 演进

`users` / `user_roles` 是全平台唯一的用户与角色主数据；本地密码单独存放在 `local_identity_credentials`。接入 OIDC/SAML 时保留用户、角色、团队和审计表，停用本地凭据并使用已有的 `identity_provider` / `external_subject` 映射外部身份。Portal 继续发放自己的短期应用会话，下游协议无需变化。
