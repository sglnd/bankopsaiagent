FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    BANKOPS_PORTAL_HOST=0.0.0.0 \
    BANKOPS_PORTAL_PORT=8080

WORKDIR /opt/bankops/portal
COPY apps/bankops-portal/ ./

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
