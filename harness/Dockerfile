FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.0-rc.6

ENV NODE_ENV=production \
    DSH_HOME=/data/dsh

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ \
    && npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@11.7.0" \
    && npm cache clean --force \
    && apt-get purge --yes --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/bankops

COPY plugins/bankops-core/ ./plugins/bankops-core/
COPY plugins/bankops-change-impact/ ./plugins/bankops-change-impact/
COPY plugins/external/dsh-genui/ ./plugins/external/dsh-genui/
COPY plugins/external/dsh-deeplink/ ./plugins/external/dsh-deeplink/
COPY plugins/external/dsh-context-doctor/ ./plugins/external/dsh-context-doctor/
COPY plugins/external/dsh-plugin-check/ ./plugins/external/dsh-plugin-check/
COPY plugins/external/dsh-security-audit/ ./plugins/external/dsh-security-audit/
COPY docker/entrypoint.sh /usr/local/bin/bankops-harness-entrypoint
COPY docker/web-proxy.mjs ./docker/web-proxy.mjs
COPY docker/migrate-profile.mjs ./docker/migrate-profile.mjs
COPY agent-api/ ./agent-api/

# Resolve all profile dependency graphs while building. Runtime startup copies
# these seeds into the persistent DSH_HOME, so normal startup needs no registry.
RUN chmod 0755 /usr/local/bin/bankops-harness-entrypoint \
    && DSH_HOME=/opt/dsh-seed dsh web --dump-config >/dev/null \
    && DSH_HOME=/opt/dsh-seed dsh --profile headless --dump-config >/dev/null \
    && cp -a /opt/dsh-seed/profiles/web /opt/dsh-seed/profiles/dev \
    && node -e "const fs=require('node:fs');const p='/opt/dsh-seed/profiles/dev/package.json';const m=JSON.parse(fs.readFileSync(p));m.name='dsh-profile-dev';fs.writeFileSync(p,JSON.stringify(m,null,2)+'\\n')" \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile web add /opt/bankops/plugins/bankops-core \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile web add /opt/bankops/plugins/bankops-change-impact \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile web add /opt/bankops/plugins/external/dsh-genui \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile web add /opt/bankops/plugins/external/dsh-deeplink \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile headless add /opt/bankops/plugins/bankops-core \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile headless add /opt/bankops/plugins/bankops-change-impact \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile dev add /opt/bankops/plugins/bankops-core \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile dev add /opt/bankops/plugins/bankops-change-impact \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile dev add /opt/bankops/plugins/external/dsh-context-doctor \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile dev add /opt/bankops/plugins/external/dsh-plugin-check \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile dev add /opt/bankops/plugins/external/dsh-security-audit \
    && DSH_HOME=/opt/dsh-seed dsh --profile web --dump-config >/dev/null \
    && DSH_HOME=/opt/dsh-seed dsh --profile headless --dump-config >/dev/null \
    && DSH_HOME=/opt/dsh-seed dsh --profile dev --dump-config >/dev/null

RUN mkdir -p /data/dsh /data/agent-api /workspace \
    && chown -R node:node /data/dsh /data/agent-api /workspace /opt/dsh-seed /opt/bankops

USER node
WORKDIR /workspace

EXPOSE 3080

ENTRYPOINT ["bankops-harness-entrypoint"]
CMD ["dsh", "--profile", "web", "--host", "127.0.0.1", "--port", "3081"]
