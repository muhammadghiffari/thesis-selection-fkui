# ---------- build ----------
FROM node:22-slim AS build # (node:22 required)
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci

COPY tsconfig*.json ./
COPY src src
COPY workers workers
COPY drizzle drizzle
COPY web/tsconfig.json web/tsconfig.json
COPY web/index.html web/index.html
COPY web/vite.config.ts web/vite.config.ts
COPY web/public web/public
COPY web/src web/src
RUN npm run build:server && npm run build --workspace web && npm prune --omit=dev

# ---------- runtime (server + workers share one image; Render free runs them as one process) ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Render free: non-root user; PORT comes from Render (main.ts falls back to 3000 when unset).
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data/exports /app/web-dist \
  && chown -R node:node /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/drizzle drizzle
COPY --from=build /app/web/dist /app/web-dist
USER node
# Render-tolerant healthcheck: probes /api/health on the Render-injected PORT.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-3000}/api/health"
CMD ["sh", "-c", "node dist/src/shared/db/migrate-cli.js && exec node dist/src/main.js"]
