FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl iproute2 && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node certs ./certs

RUN mkdir -p /data /keep /app/certs && chown -R node:node /app /data /keep /app/certs

ENV PORT=3000
ENV DATABASE_FILE=/data/keep.sqlite
ENV KEEP_DIR=/keep
ENV CERTS_DIR=/app/certs

VOLUME ["/data"]

EXPOSE 3000

USER node

CMD ["node", "server.js"]
