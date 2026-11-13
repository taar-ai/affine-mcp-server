# syntax=docker/dockerfile:1

# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/taar-ai/affine-mcp-server" \
      org.opencontainers.image.vendor="Taar" \
      org.opencontainers.image.revision=$SOURCE_REVISION

# Non-root user for security
RUN addgroup -S -g 10001 affine && adduser -S -u 10001 affine -G affine

WORKDIR /app

# Copy only what is needed to run
COPY --from=builder --chown=affine:affine /app/node_modules ./node_modules
COPY --from=builder --chown=affine:affine /app/dist ./dist
COPY --chown=affine:affine bin/ ./bin/
COPY --chown=affine:affine package.json ./
COPY --chown=affine:affine tool-manifest.json ./

USER 10001:10001

EXPOSE 3000

ENV MCP_TRANSPORT=http \
    AFFINE_MCP_HTTP_HOST=0.0.0.0 \
    PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["node", "bin/affine-mcp"]
CMD ["--"]
