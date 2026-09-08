# Prisma's native query engine supports ARM64 on Alpine. Build with:
# docker buildx build --platform linux/arm64 -t dj-library-api:latest .
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY static ./static
RUN npm install
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev
RUN cp node_modules/alpinejs/dist/cdn.min.js static/alpine.min.js

FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=file:/app/data/dev.db \
    MUSIC_ROOT=/music \
    MUSIC_PATH=/music/ \
    API_BASE_URL=http://192.168.2.5:8080 \
    CORS_ORIGIN=http://192.168.2.5:8080 \
    LOG_LEVEL=info \
    SEED_DATABASE=false

WORKDIR /app
RUN apk add --no-cache openssl \
    && addgroup -S app && adduser -S -G app app \
    && mkdir -p /app/data \
    && chown -R app:app /app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/static ./static
COPY --chown=app:app docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0555 ./docker-entrypoint.sh

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
