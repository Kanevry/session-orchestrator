# Anonymous usage-telemetry ingest server (Epic #841, S5 / GitLab #846).
# Dependency-free — node:http + node:sqlite only, so there is NO `npm install`
# step. node:sqlite runs flag-free on Node 24.
FROM node:24-alpine

WORKDIR /app

# Only the ingest server sources are copied — nothing else from the repo.
COPY server/ingest/ ./server/ingest/

ENV NODE_ENV=production \
    SO_INGEST_DB=/data/records.db \
    PORT=8787

# Persistent, node-owned data volume for the SQLite database (+ WAL sidecars).
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server/ingest/server.mjs"]
