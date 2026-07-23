ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG MCP_PROXY_VERSION=6.5.4

RUN npm install --global "mcp-proxy@${MCP_PROXY_VERSION}" @modelcontextprotocol/server-filesystem \
    && npm cache clean --force \
    && mkdir -p /workspace /var/log/bankops /config

WORKDIR /workspace
EXPOSE 8932
ENTRYPOINT []
