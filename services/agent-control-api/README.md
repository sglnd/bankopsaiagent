# Agent Control API

The control-plane API owns task lifecycle, Skill publishing, MCP catalog
discovery, idempotency, and the stable business API consumed by BankOps Portal.

It does not own browser UI and must not expose database or MCP credentials to a
browser. `/skill-studio` remains only as a compatibility redirect to Portal.
