ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG MCP_PROXY_VERSION=6.5.4
# Keep Python and its shared libraries in the same base image. Copying
# /usr/local from python:* into node:* can mix incompatible glibc versions.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-pip \
    && python3 -m pip install --no-cache-dir --break-system-packages mcp-server-git \
    && npm install --global "mcp-proxy@${MCP_PROXY_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /var/log/bankops /config

WORKDIR /workspace
EXPOSE 8933
ENTRYPOINT []
