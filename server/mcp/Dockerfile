# Public read-only MCP server for the OpenAI plugin directory (#2260).
# Dependency-free: node:http only, so there is NO `npm install` step.
#
# Stage 1 builds the corpus from the public documentation in the build context.
# Stage 2 carries the server, the corpus and the two modules it imports, nothing
# else from the repository. The base image is pinned by digest (read 2026-11-23);
# Dockerfile.dockerignore keeps everything but the named sources out of the build.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS corpus
WORKDIR /src
COPY . .
RUN node server/mcp/build-corpus.mjs --repo /src --out /src/corpus.json

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY server/mcp/server.mjs server/mcp/tools.mjs server/mcp/pages.mjs server/mcp/rate-limit.mjs ./server/mcp/
COPY scripts/lib/config/section-extractor.mjs ./scripts/lib/config/
COPY --from=corpus /src/corpus.json ./server/mcp/corpus.json

ENV NODE_ENV=production \
    PORT=8788

USER node
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8788/healthz || exit 1

CMD ["node", "server/mcp/server.mjs"]
