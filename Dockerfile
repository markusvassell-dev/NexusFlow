# NexusFlow — production Dockerfile (Node monorepo: backend + built React frontend
# in one image, deployed as a single Railway service).
#
# Multi-stage: deps → build → slim runtime. The runtime binds 0.0.0.0:$PORT
# (Railway assigns PORT dynamically — see src/index.ts).

# ---- Stage 1: install all deps (dev included, for tsc/vite) ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && (npm ci || npm install)

# ---- Stage 2: build backend (tsc) + frontend (vite) ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY . .
RUN npm run build
RUN cd frontend && npm run build

# ---- Stage 3: production runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prod deps only.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY db ./db

# Non-root user.
RUN addgroup -S nexus && adduser -S nexus -G nexus
USER nexus

# Documentation only — Railway routes to $PORT regardless.
EXPOSE 3000

# Health check hits the same endpoint Railway's checker uses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "dist/index.js"]
