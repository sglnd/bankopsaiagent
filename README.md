# BankOps AI Agent

The repository is split by deployable responsibility:

- `apps/bankops-portal/`: browser UI; calls Agent Control API only.
- `services/agent-control-api/`: stable business and control-plane API.
- `services/runtime-manager/`: per-user DSH runtime lifecycle and persistent-volume ownership.
- `runtimes/deepseek-harness/`: versioned DSH runtime, profiles, and plugins.
- `mcp/`: independently deployable MCP capability services.
- `infrastructure/`: local/production composition and shared data-plane setup.

```text
Portal -> Agent Control API -> DSH Runtime
                         \----> MCP Gateway (planned) -> MCP services

Portal/DSH Gateway (planned) -> Runtime Manager -> one isolated DSH runtime per user

File/Knowledge/Memory services (planned)
             -> PostgreSQL + Elasticsearch + MinIO
```

## Local development

Start the shared data plane and MCP capabilities:

```bash
cp infrastructure/local/.env.example infrastructure/local/.env
docker compose -f infrastructure/local/docker-compose.yml up -d --build
```

Start DSH Runtime, Agent Control API, and Portal:

```bash
cp runtimes/deepseek-harness/.env.example runtimes/deepseek-harness/.env
docker compose -f runtimes/deepseek-harness/docker-compose.yml up -d --build
```

Open:

- BankOps Portal: `http://127.0.0.1:8080`
- DSH Web: `http://127.0.0.1:3080`
- Agent Control API: `http://127.0.0.1:8090`
