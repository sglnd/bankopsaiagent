# BankOps on DeepSeek Harness

This directory contains the BankOps extensions for DeepSeek Harness. The
Harness runtime remains an upstream dependency; BankOps behavior is delivered
as an out-of-tree bundle and does not patch the upstream source tree.

## Pinned upstream

The validated upstream revision is recorded in `upstream.lock.json`. All
`@deepseek-ai/dsh-*` packages used by the local profile must remain on the
matching version until the compatibility checks have passed for an upgrade.

## Layout

- `plugins/bankops-core/` owns the shared Persona, MCP clients, and policy seams.
- `plugins/bankops-change-impact/` owns only the change-impact Skill and domain rules.
- `plugins/bankops-system-inspection/` owns the application inspection workflow,
  health rules, and report contract.
- `plugins/external/` vendors reviewed third-party plugins at commits recorded in
  `upstream.lock.json`; Docker builds never follow a moving Git branch.
- `profiles/bankops-local/` is the deterministic profile template.
- `../../mcp/` remains the independently deployed capability source boundary.
- `../../services/knowledge-platform/` supplies File Service, Knowledge MCP,
  and Memory MCP. The `@bankops/dsh-knowledge-memory` bundle attaches the two
  MCP servers and their safe-use policy to every BankOps profile.
- `../../services/agent-control-api/` owns the business/control API.
- `../../apps/bankops-portal/` owns browser UI and proxies its API calls.

## Bootstrap the local profile

DeepSeek Harness stores runnable profiles under `DSH_HOME`. Keep development
state inside this repository so it is easy to inspect and discard:

```bash
export DSH_HOME="$PWD/runtimes/deepseek-harness/.dsh-home"
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile bankops-local add @deepseek-ai/dsh-headless@0.1.0-rc.6
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile bankops-local add ./runtimes/deepseek-harness/plugins/bankops-change-impact
```

Confirm that the bundle is the final layer:

```bash
npx @deepseek-ai/dsh@0.1.0-rc.6 --profile bankops-local --dump-config
```

The effective bundle order must be:

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-headless`
3. `@bankops/dsh-core`
4. `@bankops/dsh-change-impact`

The checked-in `profiles/bankops-local/package.json` documents that expected
composition. The CLI-generated profile under `DSH_HOME` is the runnable copy.

## Run

The MCP endpoints in the bundle default to localhost ports 8941-8944. They are
deliberately allowed to be absent while the plugin skeleton is developed.
Production profiles should set `BANKOPS_*_MCP_URL` and change
`failOnStartupError` to `true` after the four MCP services exist.

```bash
export DSH_HOME="$PWD/runtimes/deepseek-harness/.dsh-home"
export DEEPSEEK_API_KEY="..."
npx @deepseek-ai/dsh@0.1.0-rc.6 --profile bankops-local \
  "分析变更单 CHG20260814001 的影响"
```

## Local verification

```bash
npm --prefix runtimes/deepseek-harness/plugins/bankops-change-impact test
```

This test validates the bundle manifest, patch composition, embedded Skill, and
the three required evaluation fixtures without requiring an LLM or MCP server.

## Run with Docker

Revoke any API key that has appeared in chat, terminal output, or source
control. Generate a fresh key, then store it only in the ignored local file:

```bash
cp runtimes/deepseek-harness/.env.example runtimes/deepseek-harness/.env
# Edit the copied .env and set DEEPSEEK_API_KEY to the newly generated key.
```

Build and start the Web profile:

```bash
docker compose -f runtimes/deepseek-harness/docker-compose.yml up -d --build
docker compose -f runtimes/deepseek-harness/docker-compose.yml ps
```

Open `http://127.0.0.1:3080`. Harness state is persisted in the named volume
`bankops-dsh-data`; the development workspace is `infrastructure/local/workspace`.
The published port is bound to host loopback only. Inside the container Harness
keeps its enforced loopback bind, while a TCP forwarder exposes it solely
through Docker's host-loopback mapping; do not change that mapping to `0.0.0.0`.
The image contains pre-resolved `web`, `headless`, and `dev` profiles, so registry
access is needed at build time but not at normal container startup.

The human entry point is `http://127.0.0.1:8080`. A local-only bootstrap
administrator is created on first startup using the Compose development
defaults (`admin` / `BankOps@Local2026!`). Override that password and both
identity secrets in every shared environment. New accounts remain pending until
approved at `http://127.0.0.1:8080/admin/users`.

Portal identity now governs fixed workflows, Skill Studio, File REST, and
Knowledge REST. Harness Web is still a shared single instance and cannot safely
map each Portal session to a distinct DSH/MCP identity. Before multi-user
production access, put DSH behind an authenticated per-user runtime gateway (or
adopt an upstream native multi-tenant session facility); never publish port
3080 directly to a user network.

Profile responsibilities are deliberately separated:

- `web`: BankOps core/change-impact plus GenUI and Deeplink.
- `headless`: BankOps core/change-impact/system-inspection for automated and one-shot runs.
- `dev`: BankOps core/change-impact/system-inspection plus Context Doctor, Plugin Check, and
  Security Audit.

Eval Harness is pinned for review but intentionally not activated: its current
source has no committed `lib/` output and its exact rc.1 dependency graph does
not resolve cleanly against DSH rc.6. Do not force-install it; wait for an rc.6
compatible release or maintain a reviewed compatibility fork.

Run a development diagnostic without adding its tools to normal Web sessions:

```bash
docker compose -f runtimes/deepseek-harness/docker-compose.yml run --rm harness \
  dsh --profile dev "使用 context_audit 检查当前上下文"
```

Run a one-shot task with the same image and persistent state:

```bash
docker compose -f runtimes/deepseek-harness/docker-compose.yml run --rm harness \
  dsh --profile headless "分析变更单 CHG20260814001 的影响"
```

Stop the Web profile without deleting its state:

```bash
docker compose -f runtimes/deepseek-harness/docker-compose.yml down
```

## BankOps Agent API

The Compose project also starts a localhost-only asynchronous business API at
`http://127.0.0.1:8090`. It does not expose the DSH Web RPC protocol or accept
arbitrary prompts. Its public operations are:

- `POST /api/v1/change-impact-analyses`
- `GET /api/v1/change-impact-analyses/{analysisId}`
- `POST /api/v1/change-impact-analyses/{analysisId}/cancel`
- `POST /api/v1/system-inspections`
- `GET /api/v1/system-inspections/{inspectionId}`
- `POST /api/v1/system-inspections/{inspectionId}/cancel`
- `GET /health`

Create an idempotent analysis:

```bash
curl -i http://127.0.0.1:8090/api/v1/change-impact-analyses \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: CHG20260814001-v1' \
  -d '{"changeId":"CHG20260814001","changeType":"APPLICATION_RELEASE","requestedBy":"change-system"}'
```

Create a production system inspection (this invokes DeepSeek when runner mode is
`real`):

```bash
curl -i http://127.0.0.1:8090/api/v1/system-inspections \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: SVC-PAYMENT-GATEWAY-20260815' \
  -d '{"serviceId":"SVC-PAYMENT-GATEWAY","environment":"production","alertLookbackHours":168,"metricLookbackHours":24,"requestedBy":"inspection-platform"}'
```

The default `BANKOPS_AGENT_RUNNER_MODE=mock` validates the HTTP/task lifecycle
without querying MCP services or spending DeepSeek tokens. Set it to `real`
and recreate `agent-api` to execute the matching change-impact or system-inspection
Skill through the `headless` profile. Shared environments must set a strong
`BANKOPS_AGENT_API_TOKEN`, set `BANKOPS_AGENT_API_ALLOW_UNAUTHENTICATED=0`, and
send `Authorization: Bearer <token>`.

Tasks are persisted in the `bankops-agent-api-data` volume. A task that was
running when the worker restarted is marked failed instead of being silently
retried and consuming model tokens twice.

## Skill Studio

Open `http://127.0.0.1:8080/skill-studio` to browse the live MCP tool catalog,
create or edit user Skills, validate their selected tool dependencies, and
publish an immutable revision. If API authentication is enabled, enter the
Bearer token in the page header; it is kept in browser session storage only.

The supporting API operations are:

- `GET /api/v1/mcp-catalog` (`?refresh=1` bypasses the short cache)
- `GET|POST /api/v1/skills`
- `GET|PUT /api/v1/skills/{name}`
- `POST /api/v1/skills/{name}/validate`
- `POST /api/v1/skills/{name}/publish`
- `GET /api/v1/skills/{name}/versions`
- `POST /api/v1/skills/{name}/rollback`

Every save creates a new immutable revision under
`/data/dsh/bankops-skills/{name}/revisions/`. Each revision contains the
standard `SKILL.md`, author references, and a generated snapshot of the exact
MCP tool schemas selected by the author. Publishing only moves the
`publishedRevision` pointer, so a previous revision can be restored without
rewriting history.

Built-in BankOps Skills are protected from replacement. Create a user Skill
with a different name when adapting an existing workflow. A published user
Skill is available to the next headless DSH process. Restart the long-running
Harness Web container and start a new chat to refresh its Skill registry.
