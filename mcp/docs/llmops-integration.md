# LLMOps integration

Use the Streamable HTTP endpoints for newly configured clients:

| Capability | URL |
| --- | --- |
| Playwright | `http://HOST:8931/mcp` |
| Filesystem | `http://HOST:8932/mcp` |
| Git | `http://HOST:8933/mcp` |

Some legacy clients require SSE; the proxy-backed Filesystem and Git services
also provide `/sse`. Do not assume that a plain browser `GET` proves MCP
availability: the client must complete MCP initialization.

Agent policy should expose only the capabilities required by its job. For
example, a release-validation agent can receive Playwright and read-only
observability tools, but not a write-enabled filesystem or SSH tool.
