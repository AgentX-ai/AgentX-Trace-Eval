#!/usr/bin/env bash
# Builds a local dist/ directory laid out the same way a release tarball (see install.sh) would
# produce it: agentx, agentx-server, agentx-engine, and web/, all as siblings. Useful for testing
# the full distribution locally
# without needing a real GitHub release, e.g.:
#
#   ./build.sh
#   ./dist/agentx-server --dev
set -euo pipefail

cd "$(dirname "$0")"
OUT="dist"
rm -rf "$OUT"
mkdir -p "$OUT"

# The dashboard is the real AgentX-eval-front React app built in self-host mode (see README), not
# a separate rebuild. That repo is private, so only people with access to it (i.e. a sibling
# checkout at ../AgentX-eval-front) can build it from source here; everyone else falls back to the
# prebuilt agentx-web.tar.gz that repo's own CI publishes onto this repo's releases (see
# .github/workflows/publish-selfhost-web.yml over there, and README's "Dashboard release"), so
# `./build.sh` still works with just this repo checked out. Neither found: fall back to an
# API-only build rather than failing outright, same as findWebIndexHtml() already tolerates a
# missing web/index.html at runtime.
WEB_FRONT_DIR="../AgentX-eval-front"
WEB_RELEASE_REPO="AgentX-ai/AgentX-trace-eval"
rm -rf web
mkdir -p web

if [ -d "$WEB_FRONT_DIR" ]; then
  echo "Building web-front (self-host mode)..."
  (cd "$WEB_FRONT_DIR" && yarn install --silent && yarn build:selfhost)
  cp -r "$WEB_FRONT_DIR/dist/." web/
else
  echo "$WEB_FRONT_DIR not found, downloading prebuilt dashboard instead..."
  tag="${AGENTX_WEB_RELEASE_TAG:-latest}"
  if [ "$tag" = "latest" ]; then
    web_url="https://github.com/$WEB_RELEASE_REPO/releases/latest/download/agentx-web.tar.gz"
  else
    web_url="https://github.com/$WEB_RELEASE_REPO/releases/download/$tag/agentx-web.tar.gz"
  fi
  tmp_web_tar="$(mktemp -t agentx-web.XXXXXX.tar.gz)"
  if curl -fsSL "$web_url" -o "$tmp_web_tar"; then
    tar -xzf "$tmp_web_tar" -C web
  else
    echo "warning: no prebuilt dashboard found at $web_url (and no local AgentX-eval-front" >&2
    echo "checkout to build from) — continuing with an API-only build, no dashboard." >&2
  fi
  rm -f "$tmp_web_tar"
fi

echo "Building engine (bun build --compile)..."
(cd engine && yarn install --silent && yarn compile --silent)
cp engine/dist/agentx-engine "$OUT/agentx-engine"

echo "Building CLI (go build)..."
(cd cli && go build -o "../$OUT/agentx-server" .)
cp "$OUT/agentx-server" "$OUT/agentx" # agentx-server is agentx under a second name, see cli/main.go

echo "Copying dashboard..."
cp -r web "$OUT/web"

# Version stamp next to the binaries (engine/src/version.ts reads it): the release workflow's
# tag when set, a git describe for a local build, "dev" outside a git checkout.
stamp="${AGENTX_RELEASE_TAG:-$(git describe --tags --always 2>/dev/null || echo dev)}"
printf '%s\n' "$stamp" > "$OUT/RELEASE"

echo ""
echo "Built to $OUT/. Try it:"
echo "  ./$OUT/agentx-server --dev"
