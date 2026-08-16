ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.57.0-noble
FROM ${PLAYWRIGHT_IMAGE}

RUN npm install --global @playwright/mcp@latest \
    && npm cache clean --force

EXPOSE 8931
ENTRYPOINT ["playwright-mcp"]
