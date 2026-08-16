# BankOps Portal

This is the independently deployable BankOps web entry point. `/` serves the
operator-facing workspace while `/skill-studio` serves the administrator and
developer Skill Studio. The Portal proxies `/api/*` to Agent Control API, so
browsers never connect directly to MCP services.

`/knowledge` is the user-facing upload and retrieval verification page. The
Portal proxies file operations to File Service and searches to the Knowledge
REST endpoint; DSH itself consumes Knowledge and Memory through MCP.

Portal is also the browser identity gateway. Only `/login`, `/register`, and
authentication endpoints are public. Other pages and APIs require an Identity
Service session. Portal validates CSRF and RBAC, then signs user context for the
Agent, File, and Knowledge services.

Identity routes:

- `/login`: local account login.
- `/register`: team selection and pending registration.
- `/admin/users`: platform- or department-scoped approval and user management.
- `/account`: profile, team/role visibility, and self-service password change.
- `/knowledge`: document mutations require `KNOWLEDGE_MANAGER`.
- `/skill-studio`: requires `PLATFORM_ADMIN` or `SKILL_DEVELOPER`.
