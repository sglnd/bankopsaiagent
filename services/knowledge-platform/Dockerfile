ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production
USER node
EXPOSE 8951 8952 8953
