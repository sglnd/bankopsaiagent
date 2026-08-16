ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8960
CMD ["node", "src/server.mjs"]
