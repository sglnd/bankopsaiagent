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
- `plugins/external/` vendors reviewed third-party plugins at commits recorded in
  `upstream.lock.json`; Docker builds never follow a moving Git branch.
- `profiles/bankops-local/` is the deterministic profile template.
- `../mcp-hub/` remains the independently deployed capability boundary.

## Bootstrap the local profile

DeepSeek Harness stores runnable profiles under `DSH_HOME`. Keep development
state inside this repository so it is easy to inspect and discard:

```bash
export DSH_HOME="$PWD/harness/.dsh-home"
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile bankops-local add @deepseek-ai/dsh-headless@0.1.0-rc.6
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile bankops-local add ./harness/plugins/bankops-change-impact
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
export DSH_HOME="$PWD/harness/.dsh-home"
export DEEPSEEK_API_KEY="..."
npx @deepseek-ai/dsh@0.1.0-rc.6 --profile bankops-local \
  "分析变更单 CHG20260814001 的影响"
```

## Local verification

```bash
npm --prefix harness/plugins/bankops-change-impact test
```

This test validates the bundle manifest, patch composition, embedded Skill, and
the three required evaluation fixtures without requiring an LLM or MCP server.

## Run with Docker

Revoke any API key that has appeared in chat, terminal output, or source
control. Generate a fresh key, then store it only in the ignored local file:

```bash
cp harness/.env.example harness/.env
# Edit harness/.env and set DEEPSEEK_API_KEY to the newly generated key.
```

Build and start the Web profile:

```bash
docker compose -f harness/docker-compose.yml up -d --build
docker compose -f harness/docker-compose.yml ps
```

Open `http://127.0.0.1:3080`. Harness state is persisted in the named volume
`bankops-dsh-data`; the agent workspace is `mcp-hub/workspace` on the host.
The published port is bound to host loopback only. Inside the container Harness
keeps its enforced loopback bind, while a TCP forwarder exposes it solely
through Docker's host-loopback mapping; do not change that mapping to `0.0.0.0`.
The image contains pre-resolved `web`, `headless`, and `dev` profiles, so registry
access is needed at build time but not at normal container startup.

Profile responsibilities are deliberately separated:

- `web`: BankOps core/change-impact plus GenUI and Deeplink.
- `headless`: BankOps core/change-impact for automated and one-shot runs.
- `dev`: BankOps core/change-impact plus Context Doctor, Plugin Check, and
  Security Audit.

Eval Harness is pinned for review but intentionally not activated: its current
source has no committed `lib/` output and its exact rc.1 dependency graph does
not resolve cleanly against DSH rc.6. Do not force-install it; wait for an rc.6
compatible release or maintain a reviewed compatibility fork.

Run a development diagnostic without adding its tools to normal Web sessions:

```bash
docker compose -f harness/docker-compose.yml run --rm harness \
  dsh --profile dev "使用 context_audit 检查当前上下文"
```

Run a one-shot task with the same image and persistent state:

```bash
docker compose -f harness/docker-compose.yml run --rm harness \
  dsh --profile headless "分析变更单 CHG20260814001 的影响"
```

Stop the Web profile without deleting its state:

```bash
docker compose -f harness/docker-compose.yml down
```

## Change Impact Agent API

The Compose project also starts a localhost-only asynchronous business API at
`http://127.0.0.1:8090`. It does not expose the DSH Web RPC protocol or accept
arbitrary prompts. Its public operations are:

- `POST /api/v1/change-impact-analyses`
- `GET /api/v1/change-impact-analyses/{analysisId}`
- `POST /api/v1/change-impact-analyses/{analysisId}/cancel`
- `GET /health`

Create an idempotent analysis:

```bash
curl -i http://127.0.0.1:8090/api/v1/change-impact-analyses \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: CHG20260814001-v1' \
  -d '{"changeId":"CHG20260814001","changeType":"APPLICATION_RELEASE","requestedBy":"change-system"}'
```

The default `BANKOPS_AGENT_RUNNER_MODE=mock` validates the HTTP/task lifecycle
without querying MCP services or spending DeepSeek tokens. Set it to `real`
and recreate `agent-api` to execute the `change-impact-analysis` Skill through
the `headless` profile. Shared environments must set a strong
`BANKOPS_AGENT_API_TOKEN`, set `BANKOPS_AGENT_API_ALLOW_UNAUTHENTICATED=0`, and
send `Authorization: Bearer <token>`.

Tasks are persisted in the `bankops-agent-api-data` volume. A task that was
running when the worker restarted is marked failed instead of being silently
retried and consuming model tokens twice.
