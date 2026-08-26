# AgentX self-host engine - see README's "Docker" section.
#
# Four stages: the workspace install + judge-core build need Node/Yarn (bun install isn't a
# guaranteed match for a yarn.lock), the engine compile needs Bun (bun:sqlite, see
# storage/db.ts's own comment on why the compiled binary can't use better-sqlite3), the dashboard
# is a separate prebuilt asset (private frontend source, see README's "Dashboard release process"
# - same fallback build.sh uses when no sibling AgentX-eval-front checkout exists), and the
# runtime stage is exactly what release.yml already verified a compiled agentx-engine binary runs
# correctly under: a plain debian:bookworm-slim container.
#
# Build: docker build -t agentx-selfhost .
# Run:   docker run -p 4700:4700 -v agentx-data:/data agentx-selfhost

# --- deps: workspace install + judge-core build (Node/Yarn) ---
FROM node:25-slim AS deps
WORKDIR /app
# python3/make/g++: better-sqlite3 (engine/package.json) has a native addon needing a real build
# toolchain to compile from source (no prebuilt binary for every platform/arch combo) - it's a
# dev-only dependency in practice (the compiled agentx-engine binary uses Bun's own bun:sqlite
# instead, see storage/db.ts's comment), but yarn install still builds every listed dependency
# regardless of which runtime ultimately uses it. This stage is discarded; nothing here reaches
# the final image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
COPY engine/package.json engine/package.json
COPY packages/judge-core/package.json packages/judge-core/package.json
RUN yarn install --frozen-lockfile
COPY packages/judge-core packages/judge-core
RUN yarn workspace @agentx/judge-core build

# --- build: compile the engine to a single native binary (Bun) ---
FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/judge-core packages/judge-core
COPY engine engine
# The workspace install nests version-conflicted deps under engine/node_modules instead of
# hoisting (e.g. @modelcontextprotocol/sdk's express@5 claims the root slot, pushing the
# engine's own express@4 down here) - without this copy the compile can't resolve them.
COPY --from=deps /app/engine/node_modules engine/node_modules
RUN cd engine && bun build src/index.ts --compile --outfile /out/agentx-engine

# --- dashboard: prebuilt bundle from this repo's own GitHub releases ---
# ADD (not RUN curl) on purpose: the builder checksum-validates the URL against the remote file's
# ETag on every build, so a freshly published agentx-web.tar.gz invalidates exactly this layer
# with no --no-cache needed, while an unchanged asset still hits the cache. A RUN curl layer, by
# contrast, caches on the command text alone and silently keeps serving a stale bundle forever.
# Trade-off: no network / missing asset now fails the build loudly instead of quietly producing
# an API-only image.
#
# Pin a specific dashboard build instead of latest:
#   --build-arg AGENTX_WEB_URL=https://github.com/AgentX-ai/AgentX-trace-eval/releases/download/v0.2.0/agentx-web.tar.gz
FROM debian:bookworm-slim AS dashboard
ARG AGENTX_WEB_URL=https://github.com/AgentX-ai/AgentX-trace-eval/releases/latest/download/agentx-web.tar.gz
ADD ${AGENTX_WEB_URL} /tmp/agentx-web.tar.gz
RUN mkdir -p /web && tar -xzf /tmp/agentx-web.tar.gz -C /web && rm /tmp/agentx-web.tar.gz

# --- runtime ---
FROM debian:bookworm-slim
# ca-certificates: the engine calls out to OpenAI/Anthropic/Gemini over HTTPS for judge scoring.
# curl: used by the HEALTHCHECK below.
# python3: the Python variant of Code scorers (core/monitor/scriptScorer.ts) runs user scripts in
# a python3 subprocess - without it those scorers report "python3 was not found" per check.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /data --shell /usr/sbin/nologin agentx

WORKDIR /app
COPY --from=build /out/agentx-engine ./agentx-engine
COPY --from=dashboard /web ./web
RUN chown -R agentx:agentx /app /data

# AGENTX_HOME: where the default SQLite DB + config.json live - /data is the mounted volume, not
# the container's own ~ (root's home), so state survives a container recreate. Set
# AGENTX_DB_URL=postgres://... instead to point at your own Postgres and skip the volume.
ENV AGENTX_HOME=/data \
    PORT=4700
VOLUME ["/data"]
EXPOSE 4700
USER agentx

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

ENTRYPOINT ["./agentx-engine"]
