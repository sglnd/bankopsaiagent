# Shared data platform

BankOps DSH runtimes are disposable execution environments. Every user or task
runtime connects to the same platform services through authenticated APIs or
MCP tools; a runtime never owns an authoritative database.

```text
User DSH runtimes
        |
        v
File API / Knowledge MCP / Memory MCP / Agent Control API
        |
        +-- PostgreSQL: identity references, ACLs, task state, approvals
        +-- Elasticsearch: knowledge chunks, memories, searchable events
        `-- MinIO: original files and generated report artifacts
```

## Storage ownership

### PostgreSQL

PostgreSQL is the strong-consistency boundary. The development schema under
`infrastructure/postgres/init/001-platform.sql` creates the initial tables for departments,
users, roles, document metadata and ACLs, agent tasks, and audit events.

The platform, not a DSH container, owns database credentials. DSH receives a
short-lived identity context and calls a service that enforces authorization.

### Elasticsearch

The seed job creates three initially empty platform indices in addition to the
existing operational test data:

- `bankops-kb-documents-v1` contains a searchable projection of published
  document metadata and its effective access-control fields.
- `bankops-kb-chunks-v1` contains extracted text chunks. An embedding field is
  intentionally deferred until an embedding model and vector dimension are
  versioned as part of the indexing contract.
- `bankops-agent-memories-v1` contains approved user/workspace memories.

Unlike the six disposable scenario indices, these platform indices are never
deleted by `elasticsearch-seed`. Run only the idempotent platform initialization
against an existing environment with:

```bash
docker compose -f infrastructure/local/docker-compose.yml run --rm \
  -e BANKOPS_SEED_PLATFORM_ONLY=1 elasticsearch-seed
```

Authorization filters must be added by Knowledge/Memory services before a
query reaches Elasticsearch. Skill instructions and model prompts are not an
authorization boundary.

### MinIO

The initialization container creates private buckets:

- `bankops-files` for uploaded and knowledge-source files.
- `bankops-reports` for generated reports and exports.

Recommended object keys keep tenant and ownership visible to operators without
making object names an authorization mechanism:

```text
bankops-files/tenants/<tenantId>/knowledge/<documentId>/<version>/source
bankops-files/tenants/<tenantId>/users/<userId>/sessions/<sessionId>/<fileId>
bankops-reports/tenants/<tenantId>/tasks/<taskId>/<artifactId>
```

Access must use short-lived signed URLs or service-to-service credentials.
MinIO root credentials must never be mounted into a DSH runtime.

## Local startup

Copy `.env.example` to `.env`, replace every `*-local-change-me` value, and
start the shared data plane:

```bash
docker compose -f infrastructure/local/docker-compose.yml up -d \
  postgres minio minio-init elasticsearch elasticsearch-seed
docker compose -f infrastructure/local/docker-compose.yml ps
```

Local endpoints are bound to host loopback:

- PostgreSQL: `127.0.0.1:5432`
- Elasticsearch: `127.0.0.1:9200`
- MinIO S3 API: `127.0.0.1:9000`
- MinIO console: `127.0.0.1:9001`

These defaults are for development only. Production must use managed secrets,
TLS, backups, multi-node services, monitoring, and tested restore procedures.

## Service contracts to implement next

DSH Skills should depend on stable application contracts rather than storage
implementation details:

```text
file.create_upload
file.get_download
file.read

knowledge.ingest
knowledge.search
knowledge.read
knowledge.publish

memory.recall
memory.propose
memory.approve
memory.forget
```

This boundary allows Elasticsearch mappings, MinIO layouts, and PostgreSQL
schemas to evolve without rewriting BankOps Skills.
