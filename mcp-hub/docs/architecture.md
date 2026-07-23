# Architecture

Sprint 1 runs one MCP capability per container. The Hub is a deployment and
network boundary, not yet an MCP aggregator or security gateway.

```text
Agent -> LLMOps -> MCP Gateway (Sprint 5) -> individual MCP endpoints
                                             |-- Playwright (HTTP)
                                             |-- Filesystem (stdio + bridge)
                                             |-- Git (stdio + bridge)
                                             `-- SSH (future)
```

The filesystem reference server and Git reference server expose stdio. The
`mcp-proxy` process in those containers adapts stdio to Streamable HTTP (`/mcp`)
and legacy SSE (`/sse`). This is transport adaptation, not a fork or source
change of the official servers.

The Hub currently has no cross-service authorization. The Docker network is
only a connectivity boundary; it is not an access-control system.
