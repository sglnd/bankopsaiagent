# BankOps MCP Hub

BankOps MCP Hub is the containerized capability layer for BankOps AI Agents. It
keeps browser automation, bounded workspace access, and Git operations separate
from the future LLMOps/Agent Runtime, so that tools can be governed, audited and
expanded independently.

> Sprint 1 is a development foundation, not a production approval. In
> particular, MCP endpoints are not authenticated and must remain on a trusted
> network until the gateway and identity controls in the roadmap exist.

## Architecture

```text
LLMOps Platform / Agent Runtime
             |
             v
      BankOps MCP Hub
             |
  +----------+----------+----------+
  |          |          |          |
Playwright Filesystem   Git    SSH (template)
  8931       8932      8933        8934
```

The change-impact test stack adds one Elasticsearch data plane and four
separate domain MCP boundaries:

```text
ChangeInfo :8941   CMDB :8942   AlertInfo :8943   PerfInfo :8944
        \             |              |              /
                  Elasticsearch :9200
```

The independently located local infrastructure stack also provisions the shared
platform storage foundation:

```text
PostgreSQL :5432  strong-consistency metadata, ACL and task boundary
MinIO      :9000  private original-file and report object storage
MinIO UI   :9001  localhost-only development console
Elasticsearch     knowledge, memory and searchable operational projections
```

These services are shared by all future per-user DSH instances. DSH must use
them through File, Knowledge, Memory, and Control services rather than receiving
database administrator credentials. See [shared data platform](docs/data-platform.md).

The seeded scenarios are `CHG20260814001` (payment application release) and
`CHG20260814002` (DMZ-to-core firewall opening). Re-running
`elasticsearch-seed` recreates all six `bankops-*-v1` indices deterministically.
The payment service `SVC-PAYMENT-GATEWAY` also contains inspection-oriented
CMDB assets: application modules, Kubernetes and IP nodes, database instances,
Redis nodes, Kafka brokers, load balancing and direct upstream/downstream
dependencies. Its performance index includes service health plus compute,
database, middleware, storage, connection and queue-capacity metrics.

All enabled services use the `bankops-network` Docker network. The host
directories under `infrastructure/local/` are mounted into each service;
only `workspace/` is granted to the official filesystem/Git servers as their
working scope.

## Quick start

```bash
cp infrastructure/local/.env.example infrastructure/local/.env
docker compose -f infrastructure/local/docker-compose.yml up -d --build
docker compose -f infrastructure/local/docker-compose.yml ps
infrastructure/local/scripts/smoke-test.sh
```

Stop it with `docker compose -f infrastructure/local/docker-compose.yml down`.

For offline production delivery, set `TARGET_PLATFORM` in `.env` to the
target host platform before building. The supplied value, `linux/amd64`, is
correct for an `x86_64` Linux host. Build and export on the connected machine,
then import the resulting image archive on the disconnected host.

## MCP endpoints

| Service | Primary endpoint | Compatibility endpoint |
| --- | --- | --- |
| Playwright | `http://localhost:8931/mcp` | `http://localhost:8931/sse` when supported by the installed Playwright MCP version |
| Filesystem | `http://localhost:8932/mcp` | `http://localhost:8932/sse` |
| Git | `http://localhost:8933/mcp` | `http://localhost:8933/sse` |
| SSH | Reserved: `http://localhost:8934` | Disabled template |
| ChangeInfo | `http://localhost:8941/mcp` | — |
| CMDB | `http://localhost:8942/mcp` | — |
| AlertInfo | `http://localhost:8943/mcp` | — |
| PerfInfo | `http://localhost:8944/mcp` | — |
| Knowledge | `http://localhost:8952/mcp` | — |
| Memory | `http://localhost:8953/mcp` | — |

CMDB exposes `get_service_inventory` for a service-level asset census. The
inspection workflow then calls PerfInfo `list_available_metrics` before using
`get_performance_summary`, so callers do not need to guess metric names.
All BankOps domain MCP input fields include JSON Schema descriptions. Skill
Studio reads those schemas through MCP `tools/list`; the tool catalog is not a
separately maintained document.

`/mcp` is the preferred Streamable HTTP endpoint. Filesystem and Git are
official reference MCP servers that are stdio-only; the dedicated `mcp-proxy`
container process supplies HTTP/SSE transport without changing their source.

Playwright runs the official Playwright MCP with Chromium in headless mode. Its
current official standalone configuration uses `/mcp`; use that endpoint for
new LLMOps integrations.

## LLMOps integration

Configure each MCP as a remote HTTP server, for example:

```json
{
  "mcpServers": {
    "bankops-filesystem": { "url": "http://HOST:8932/mcp" },
    "bankops-git": { "url": "http://HOST:8933/mcp" },
    "bankops-playwright": { "url": "http://HOST:8931/mcp" }
  }
}
```

For a first smoke test, open the MCP Inspector against one endpoint or use the
HTTP configuration supported by your LLMOps platform. A simple browser visit to
an MCP endpoint alone is not a full protocol test because MCP requires an
initialization request/session.

## Operations

```bash
infrastructure/local/scripts/build.sh
infrastructure/local/scripts/smoke-test.sh
node mcp/scripts/test-domain-mcps.mjs
node mcp/scripts/test-knowledge-memory.mjs
infrastructure/local/scripts/export.sh
infrastructure/local/scripts/import.sh /path/to/images.tar
docker compose -f infrastructure/local/docker-compose.yml --profile ssh up -d
```

Copy the project directory and the exported TAR to the Linux target, run the
import script, then start `infrastructure/production/docker-compose.yml`. Image export makes
the built, tested image bytes portable; retain the project configuration and a
versioned `.env` alongside the archive.

## Verification

Each enabled service has a container health check that confirms its local MCP
endpoint is responding. `infrastructure/local/scripts/smoke-test.sh` performs the stronger external
check: it sends the MCP `initialize` request to Playwright, Filesystem, and Git
and requires a successful JSON-RPC result. Run it after the local Compose stack
and before exporting images or handing an environment to an agent runtime.

The script retries for 90 seconds by default. Override that window with
`SMOKE_TEST_TIMEOUT_SECONDS`, or set `MCP_PROTOCOL_VERSION` when validating a
client that requires a different negotiated protocol version.

## Security baseline

- Do not publish ports 8931–8934 directly beyond a trusted development network.
- Treat `workspace/` as an agent-writeable boundary; do not mount secrets,
  production configuration, or a user home directory there.
- Use a dedicated Git identity and keep credentials out of `.env` and image
  layers.
- SSH is intentionally an opt-in empty template until a reviewed implementation
  provides authentication, target/command allowlists, audit records and host-key
  verification.
- Before production, add the MCP Gateway layer for SSO/workload identity,
  authorization, policy enforcement, audit logging, rate limits, TLS and tool
  inventory.

See [architecture](docs/architecture.md), [deployment](docs/deployment.md),
[LLMOps integration](docs/llmops-integration.md), and the [roadmap](docs/roadmap.md).
