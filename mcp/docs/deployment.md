# Deployment

1. On a connected build host, copy `infrastructure/local/.env.example` to
   `infrastructure/local/.env`, review image tags, and run
   `infrastructure/local/scripts/build.sh`.
2. Start the local stack and run `infrastructure/local/scripts/smoke-test.sh` to verify MCP initialization
   succeeds on every enabled service. Then exercise the target MCP clients
   against the built images.
3. Run `infrastructure/local/scripts/export.sh`; transfer
   `infrastructure/local/exports/bankops-mcp-images.tar` and the
   versioned project configuration through the bank-approved channel.
4. On the Linux Docker host, run
   `infrastructure/local/scripts/import.sh /path/to/bankops-mcp-images.tar`.
5. Start `infrastructure/production/docker-compose.yml` with `--no-build` and
   inspect its status and logs.

The compose file uses bind mounts for predictable local development. For a
server, use a protected project directory with owner/group permissions suitable
for the Docker daemon. Do not convert `config/` into a secrets store; supply
production secrets from the approved platform.

Before any non-development deployment, put the Hub behind TLS and a gateway
that enforces identity, authorization, session auditing, rate limits, and an
egress policy.
