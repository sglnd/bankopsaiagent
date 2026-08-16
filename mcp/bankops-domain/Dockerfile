ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY src ./src

ENV PORT=8941
EXPOSE 8941 8942 8943 8944
USER node
ENTRYPOINT []
CMD ["node", "src/server.js"]
