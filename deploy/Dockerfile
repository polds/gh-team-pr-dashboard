FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build -w @radar/web

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci --omit=dev --workspace @radar/server --workspace @radar/core --include-workspace-root

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 RADAR_DATA_DIR=/data RADAR_WEB_DIST=/app/packages/web/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/core/src packages/core/src
COPY packages/server/package.json packages/server/package.json
COPY packages/server/src packages/server/src
COPY --from=build /app/packages/web/dist packages/web/dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "packages/server/src/main.ts"]
