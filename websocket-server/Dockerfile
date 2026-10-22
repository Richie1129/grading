# Multi-stage build for WebSocket server
# Node 20 已 EOL；釘到確切修補版 22.23.4（含 2026-10 安全修補，CVE-2026-111497 等）
FROM node:22.23.4-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Build stage
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# Production stage
FROM base AS runner
WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 socketio \
    && adduser --system --uid 1001 socketio

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

USER socketio

EXPOSE 3001

ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(() => process.exit(0)).catch(() => process.exit(1))"

CMD ["npm", "start"]