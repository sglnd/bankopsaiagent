# Roadmap

## Sprint 2 — data capabilities

- Prometheus MCP
- Elasticsearch MCP
- MySQL MCP
- Redis MCP

## Sprint 3 — bank-owned MCPs (Go)

- CMDB, unified monitoring, ITSM and automation-platform MCPs
- Unified-alert and operations-data-platform MCPs
- Each server ships with least privilege, versioned tool schemas, tests, audit
  events and an owner/runbook.

## Sprint 4 — operations agents

- Release validation agent
- Inspection agent
- Incident and log-analysis agents
- Automated test agent

## Sprint 5 — MCP Gateway / Agent Runtime controls

- Workload identity, authorization, tenancy and policy
- Tool catalog/discovery and approval workflows
- Audit, tracing, rate limits, TLS and egress controls
- Central session lifecycle and LLMOps integration

## Sprint 6 — authenticated per-user DSH runtimes

The target interaction model is one persistent DSH workspace per user, with at
most one active runtime. Runtimes start on demand and stop after an idle
timeout. PostgreSQL, Elasticsearch and MinIO remain shared platform services;
isolation is enforced with tenant, department, user, workspace and ACL fields.

### Phase 1 — runtime control plane and browser gateway

- [ ] Add a Runtime Manager service and PostgreSQL migrations for runtimes,
  leases and lifecycle audit events.
- [ ] Define a provider interface for start, stop, resume, inspect and delete;
  implement the local Docker provider first and retain a Kubernetes provider
  boundary for production.
- [ ] Enforce one active runtime per user with database locking and idempotent
  launch requests.
- [ ] Give every user an isolated DSH home and workspace volume; do not share
  the current `bankops-dsh-data` or `/workspace` mounts between users.
- [ ] Add a DSH Gateway that validates the Portal session, exchanges a
  short-lived single-use launch ticket, and proxies HTTP, SSE and WebSocket
  traffic to the owning runtime.
- [ ] Add an "AI 工作台" launch/resume entry to Portal and expose DSH only
  through the authenticated gateway.
- [ ] Remove direct user access to port 3080; runtime containers must have no
  published host port and must be reachable only on an internal network.
- [ ] Add health checks, startup timeout, per-runtime CPU/memory/process limits,
  idle stop, resume and retention cleanup.

### Phase 2 — trusted MCP user identity and data authorization

- [ ] Add an MCP Gateway between DSH runtimes and all domain, Knowledge and
  Memory MCP services.
- [ ] Issue short-lived, scoped workload credentials to runtimes; never inject
  a Portal cookie or user password into a runtime.
- [ ] Resolve workload credentials to tenant, user, department, roles, runtime
  and workspace at the gateway, then sign the downstream identity envelope.
- [ ] Strip caller-supplied identity headers and make downstream MCP services
  trust only gateway-signed identity.
- [ ] Enforce tenant, department, owner, workspace, visibility and document ACL
  filters consistently in PostgreSQL, Elasticsearch and MinIO access paths.
- [ ] Record user-attributed MCP tool calls, authorization decisions and data
  access in the audit trail.

### Phase 3 — production hardening and upgrade lifecycle

- [ ] Add active-runtime quotas, launch admission control, back-pressure and
  operational dashboards/alerts.
- [ ] Add network egress policy so runtimes can reach only approved private
  model endpoints, MCP Gateway and required platform services.
- [ ] Inject any private-model service credential through Docker/Kubernetes
  secrets; never persist it in images, source, PostgreSQL or user workspaces.
- [ ] Version runtime images in PostgreSQL and implement canary, drain, restart
  and rollback procedures without coupling Portal upgrades to DSH upgrades.
- [ ] Implement the Kubernetes provider with per-user Pods/PVCs, NetworkPolicy,
  resource limits, security context and highly available gateway/control-plane
  replicas.
- [ ] Add backup, restore, disaster-recovery and orphaned-runtime reconciliation
  tests.

### Explicitly deferred

- [ ] LLM Gateway, external compute exposure, commercial billing and per-user
  token charging are deferred. Production models are privately deployed and
  used only by internal users. Reconsider a model gateway only when multi-model
  routing, centralized model authorization or resource-contention governance is
  required.
