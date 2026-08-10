# AgentX self-host engine — see README's "Docker" section.
#
# Four stages: the workspace install + judge-core build need Node/Yarn (bun install isn't a
# guaranteed match for a yarn.lock), the engine compile needs Bun (bun:sqlite, see
# storage/db.ts's own comment on why the compiled binary can't use better-sqlite3), the dashboard
# is a separate prebuilt asset (private frontend source, see README's "Dashboard release process"
# — same fallback build.sh uses when no sibling AgentX-eval-front checkout exists), and the
# runtime stage is exactly what release.yml already verified a compiled agentx-engine binary runs
# correctly under: a plain debian:bookworm-slim container.
#
# Build: docker build -t agentx-selfhost .
# Run:   docker run -p 4700:4700 -v agentx-data:/data agentx-selfhost

# --- deps: workspace install + judge-core build (Node/Yarn) ---
FROM node:24-slim AS deps
WORKDIR /app
# python3/make/g++: better-sqlite3 (engine/package.json) has a native addon needing a real build
# toolchain to compile from source (no prebuilt binary for every platform/arch combo) — it's a
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
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/judge-core packages/judge-core
COPY engine engine
RUN cd engine && bun build src/index.ts --compile --outfile /out/agentx-engine

# --- dashboard: prebuilt bundle from this repo's own GitHub releases ---
FROM debian:bookworm-slim AS dashboard
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG AGENTX_WEB_RELEASE_TAG=latest
RUN mkdir -p /web && \
    if [ "$AGENTX_WEB_RELEASE_TAG" = "latest" ]; then \
      web_url="https://github.com/AgentX-ai/AgentX-trace-eval/releases/latest/download/agentx-web.tar.gz"; \
    else \
      web_url="https://github.com/AgentX-ai/AgentX-trace-eval/releases/download/${AGENTX_WEB_RELEASE_TAG}/agentx-web.tar.gz"; \
    fi && \
    if curl -fsSL "$web_url" -o /tmp/agentx-web.tar.gz; then \
      tar -xzf /tmp/agentx-web.tar.gz -C /web && rm /tmp/agentx-web.tar.gz; \
    else \
      echo "warning: no prebuilt dashboard found at $web_url — continuing API-only" >&2; \
    fi

# --- runtime ---
FROM debian:bookworm-slim
# ca-certificates: the engine calls out to OpenAI/Anthropic/Gemini over HTTPS for judge scoring.
# curl: used by the HEALTHCHECK below.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /data --shell /usr/sbin/nologin agentx

WORKDIR /app
COPY --from=build /out/agentx-engine ./agentx-engine
COPY --from=dashboard /web ./web
RUN chown -R agentx:agentx /app /data

# AGENTX_HOME: where the default SQLite DB + config.json live — /data is the mounted volume, not
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
