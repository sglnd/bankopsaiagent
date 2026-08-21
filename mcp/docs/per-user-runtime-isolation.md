# Per-user Runtime, Skill, and MCP Isolation

This document records the local Runtime Manager MVP and the target Kubernetes
design. It is the migration contract: containers and Pods are disposable;
identity, state ownership, and policy are stable platform concerns.

## Current local MVP

`services/runtime-manager/` implements the first control-plane boundary:

- one non-deleted runtime per `(tenant_id, user_id)`, enforced by a PostgreSQL
  advisory lock and a partial unique index;
- a provider interface with create, inspect, start, stop, and delete operations;
- a local Docker provider;
- one persistent DSH home volume and one persistent workspace volume per user;
- runtime image and DSH version recorded in PostgreSQL;
- lifecycle audit events; and
- deletion of the runtime container without deletion of either user volume.

The local Docker provider is a development bridge, not the production
deployment model. Its Docker socket is a host-level trust boundary and must be
restricted to the Runtime Manager service. User DSH runtimes never receive the
socket.

## State ownership

| State | Owner | Local Docker | Kubernetes target |
|---|---|---|---|
| DSH sessions and settings | user | `bankops-dsh-home-<tenant>-<user>` | per-user DSH Home PVC |
| Personal Skill revisions | user | directory under the DSH Home volume | per-user DSH Home PVC or scoped Skill service cache |
| Workspace files | user/workspace | `bankops-workspace-<tenant>-<user>` | per-user Workspace PVC |
| Runtime lifecycle and version | platform | PostgreSQL | PostgreSQL |
| Knowledge and long-term memory | platform services | PostgreSQL/Elasticsearch/MinIO | shared managed data services |
| MCP authorization policy | platform | planned MCP Gateway | MCP Gateway and policy store |
| Runtime process memory | runtime | container memory | Pod memory; not durable |

## Skill isolation and loading

Skills have three ownership tiers:

1. **Platform Skills** are reviewed BankOps bundles baked into the immutable
   runtime image. Every eligible runtime receives the same version selected by
   its runtime image.
2. **Tenant or department Skills** are centrally published and assigned by
   policy. They are read-only to ordinary users and must carry tenant,
   department, role, revision, and publisher metadata.
3. **Personal Skills** are owned by exactly one tenant user. They are editable
   through Skill Studio and become visible only in that user's runtime.

The deterministic load order is platform, tenant/department, then personal.
Later tiers must not replace protected platform names. Duplicate names across
non-platform tiers are rejected at publish time rather than resolved by load
order.

The existing `@bankops/dsh-user-skills` loader reads only an immutable
`publishedRevision` below `$DSH_HOME/bankops-skills`. When every user has a
separate DSH Home PVC, this already provides filesystem-level isolation for
personal Skill loading. A new DSH process loads the published revisions; a
long-running process starts a new session or restarts when its Skill generation
changes.

The current Skill Studio stores revisions in the shared local
`bankops-dsh-data` volume. Before multi-user use, its storage contract must add:

```text
tenant_id
owner_type       PLATFORM | TENANT | DEPARTMENT | USER
owner_id
skill_name
revision
published_revision
required_tools
content_hash
created_by
```

Skill Studio must derive the owner from the trusted Portal session. It must
never accept `tenant_id` or `user_id` from an untrusted request body. Publishing
updates a scoped Skill generation. Runtime Manager materializes or synchronizes
only the revisions authorized for the target user into that user's DSH Home.

Skill declarations such as `selectedTools` are dependency metadata and an
authoring-time validation aid. They are not authorization. A prompt or Skill
file cannot grant access to an MCP tool.

## MCP isolation and loading

Most MCP servers should remain shared platform services. Running a separate
CMDB, Knowledge, Alert, or Memory MCP server for every user would duplicate
stateful services without improving authorization. Isolation belongs at the MCP
Gateway and the downstream data filters.

The production request path is:

```text
User DSH Runtime
  -> MCP Gateway
  -> authenticate short-lived runtime credential
  -> resolve tenant, user, department, roles, runtime, and workspace
  -> authorize server + tool + resource scope
  -> sign the downstream identity envelope
  -> shared MCP service
```

Each runtime receives a short-lived workload credential, preferably through a
projected Kubernetes ServiceAccount token exchange. Portal cookies, passwords,
database credentials, MinIO credentials, and long-lived MCP secrets are never
mounted into a runtime.

At runtime startup, the Gateway returns a policy-filtered MCP catalog. DSH is
configured with Gateway endpoints only; direct network access from user Pods to
backend MCP services is denied by NetworkPolicy. Every tool call is authorized
again at execution time because catalog visibility alone is not a security
boundary. The Gateway strips caller-supplied identity headers and records the
user, runtime, Skill, tool, authorization decision, and resource identifiers in
the audit trail.

MCP capabilities that genuinely operate on a user's local workspace, such as a
filesystem or Git tool, may run as a sidecar in the user's Pod or as a
runtime-scoped service. Such a capability mounts only that user's Workspace PVC
and is reachable only by the owning Pod/Gateway route. It does not receive
access to another user's PVC or the shared Docker/Kubernetes control plane.

## Kubernetes provider mapping

The Kubernetes provider implements the existing Runtime Provider contract:

| Provider operation | Kubernetes action |
|---|---|
| create | create/claim two PVCs, Service, Pod, and NetworkPolicy |
| inspect | read Pod conditions and selected image/version |
| start/resume | create a Pod mounting the existing PVCs |
| stop | delete the Pod while retaining PVCs and runtime record |
| delete | delete Pod and Service; retain PVCs by default |
| purge (future) | separately authorized PVC snapshot and deletion workflow |

Each Pod receives a restrictive security context, resource limits, an internal
Service without public exposure, and egress only to the private model endpoint
and MCP Gateway. DSH Gateway maps the authenticated Portal user to the owning
runtime record and proxies HTTP, SSE, and WebSocket traffic to that internal
Service.

## Migration gates

Kubernetes migration is complete only when the following checks pass:

- stopping and recreating a Pod preserves DSH sessions, settings, Skills, and
  workspace files;
- a user cannot list, mount, route to, or query another user's runtime or PVC;
- a personal Skill is visible only to its owner;
- a department Skill is visible only to eligible department members;
- protected platform Skills cannot be replaced;
- direct runtime-to-MCP traffic is blocked;
- MCP catalog results and every tool execution are independently authorized;
- runtime image upgrades use PVC snapshots or clones and support rollback; and
- orphaned Pods, Services, PVCs, and runtime database records are reconciled.
