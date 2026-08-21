# BankOps Runtime Manager

The Runtime Manager owns the lifecycle metadata for one isolated DSH runtime
per tenant user. Runtime containers are disposable; the user's DSH home and
workspace are independent named volumes and survive stop, restart, image
upgrade, and the default delete operation.

## API

All lifecycle endpoints require `Authorization: Bearer
<BANKOPS_RUNTIME_INTERNAL_TOKEN>`. `GET /health` is unauthenticated.

- `POST /api/v1/runtimes` with `{ "tenantId", "userId", "start": true }`
- `GET /api/v1/runtimes/{runtimeId}`
- `POST /api/v1/runtimes/{runtimeId}/start`
- `POST /api/v1/runtimes/{runtimeId}/stop`
- `DELETE /api/v1/runtimes/{runtimeId}`

Creation is idempotent per `(tenantId, userId)` and serialized with a
PostgreSQL advisory lock. The database also has a partial unique index that
enforces at most one non-deleted runtime for each tenant user.

Deleting a runtime removes only its Docker container. Its `dsh-home` and
`workspace` volumes remain available for recovery. Volume purge and retention
must be implemented as a separate, explicitly authorized operation.

## Provider boundary

`RuntimeManager` depends on a provider with `create`, `inspect`, `start`,
`stop`, and `delete` methods. The local implementation uses the Docker Engine
API through its Unix socket. A Kubernetes provider can implement the same
contract without changing the API or database lifecycle model.

The Docker socket grants host-level container management capability. Mount it
only into this control-plane service, never into user DSH runtimes, and protect
the Runtime Manager network and internal token.

The Compose definition intentionally has no fallback internal token. Set a
random value of at least 24 characters in the ignored local `.env` before
starting the service. Starting the Docker provider also requires explicit
approval of the Docker socket trust boundary.

The durable Docker-to-Kubernetes migration contract, including Skill and MCP
isolation, is maintained in
[`../../mcp/docs/per-user-runtime-isolation.md`](../../mcp/docs/per-user-runtime-isolation.md).
