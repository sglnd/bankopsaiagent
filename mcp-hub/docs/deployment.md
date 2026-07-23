# Deployment

1. On a connected build host, copy `.env.example` to `.env`, review image tags,
   and run `scripts/build.sh`.
2. Start the Hub and run `scripts/smoke-test.sh` to verify MCP initialization
   succeeds on every enabled service. Then exercise the target MCP clients
   against the built images.
3. Run `scripts/export.sh`; transfer `exports/bankops-mcp-images.tar` and the
   versioned project configuration through the bank-approved channel.
4. On the Linux Docker host, run `scripts/import.sh /path/to/bankops-mcp-images.tar`.
5. Start with `docker compose up -d --no-build` and inspect `docker compose ps`
   plus `docker compose logs`.

The compose file uses bind mounts for predictable local development. For a
server, use a protected project directory with owner/group permissions suitable
for the Docker daemon. Do not convert `config/` into a secrets store; supply
production secrets from the approved platform.

Before any non-development deployment, put the Hub behind TLS and a gateway
that enforces identity, authorization, session auditing, rate limits, and an
egress policy.
