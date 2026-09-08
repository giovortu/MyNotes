FROM node:22-bookworm-slim

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

RUN mkdir -p /data /keep && chown -R node:node /app /data /keep

ENV PORT=3000
ENV DATABASE_FILE=/data/keep.sqlite
ENV KEEP_DIR=/keep

VOLUME ["/data"]

EXPOSE 3000

USER node

CMD ["node", "server.js"]
