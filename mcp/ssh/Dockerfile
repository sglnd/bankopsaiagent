FROM alpine:3.21
RUN adduser -D -u 10001 mcp
USER mcp
EXPOSE 8934
# Template guardrail: a real implementation must add authentication, allowlists,
# auditing, host-key verification, and a command policy before this is exposed.
CMD ["sh", "-c", "echo 'SSH MCP is a disabled template; see services/ssh/README.md'; tail -f /dev/null"]
