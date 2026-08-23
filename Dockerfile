# ---------- build ----------
FROM node:22-slim AS build
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci

COPY tsconfig*.json ./
COPY src src
COPY workers workers
RUN npm run build:server && npm prune --omit=dev

# ---------- runtime (server + workers share one image) ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/drizzle drizzle
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD curl -fsS http://localhost:3000/api/health || exit 1
CMD ["sh", "-c", "node dist/src/shared/db/migrate-cli.js && exec node dist/src/main.js"]
