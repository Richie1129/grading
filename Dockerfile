FROM node:22-alpine AS builder

ARG BUILD_VERSION=1.0.0
ARG BUILD_BRANCH=unknown
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate

RUN echo "{\"version\":\"${BUILD_VERSION}\",\"branch\":\"${BUILD_BRANCH}\",\"commitHash\":\"${BUILD_COMMIT}\",\"buildTime\":\"${BUILD_TIME}\"}" > version.json && \
    cat version.json

RUN npm run build

FROM node:22-slim AS production

WORKDIR /app

# Install Chrome dependencies and Chinese fonts for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# tsx 給 scripts/（npm run seed:admin 等）用；寫 /usr/local 需要 root，所以放在切換使用者之前
RUN npm install -g tsx

# 之後全部以非 root 的 node 使用者（uid 1000，node 官方映像內建）執行。
# Puppeteer 啟動 Chromium 時已帶 --no-sandbox / --disable-setuid-sandbox，非 root 不受影響。
RUN chown node:node /app
USER node

COPY --chown=node:node package*.json ./
COPY --chown=node:node prisma ./prisma/

# 依 lockfile 安裝 production 相依（與 builder 的 npm ci 一致，不用 npm install 以免版本漂移）。
# prisma CLI 列在 dependencies，供部署時 npx prisma migrate deploy 使用。
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/app/generated ./app/generated
COPY --from=builder --chown=node:node /app/version.json ./version.json
COPY --from=builder --chown=node:node /app/scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
