#!/usr/bin/env bash
# curl -sSL https://raw.githubusercontent.com/AgentX-ai/AgentX-trace-eval/main/install.sh | bash
#
# Installs the agentx / agentx-server CLI by downloading the prebuilt binary for this platform
# from GitHub Releases. Requires no Go, Node, or Bun on the machine running this script: those
# are only needed to build the project, not to install it (see engine/'s Bun single-binary
# packaging, plan task #113).
set -euo pipefail

REPO="AgentX-ai/AgentX-trace-eval"
INSTALL_DIR="${AGENTX_INSTALL_DIR:-$HOME/.agentx/bin}"
# Script-global, not local to main(): the `trap ... EXIT` below fires after main() returns (once
# the script reaches its natural end at the bottom), by which point a `local` tmp_dir would
# already be out of scope — under `set -u` that was an unbound-variable error on every single
# run, not just a corner case, verified by actually running this script end to end.
tmp_dir=""

os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
}

arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "amd64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

main() {
  local platform_os platform_arch version url
  platform_os="$(os)"
  platform_arch="$(arch)"
  version="${AGENTX_VERSION:-latest}"

  if [ "$version" = "latest" ]; then
    url="https://github.com/${REPO}/releases/latest/download/agentx_${platform_os}_${platform_arch}.tar.gz"
  else
    url="https://github.com/${REPO}/releases/download/${version}/agentx_${platform_os}_${platform_arch}.tar.gz"
  fi

  echo "Installing agentx (${platform_os}/${platform_arch})..."
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  curl -fsSL "$url" -o "$tmp_dir/agentx.tar.gz"
  tar -xzf "$tmp_dir/agentx.tar.gz" -C "$tmp_dir"

  mkdir -p "$INSTALL_DIR"
  mv "$tmp_dir/agentx" "$INSTALL_DIR/agentx"
  mv "$tmp_dir/agentx-server" "$INSTALL_DIR/agentx-server"
  mv "$tmp_dir/agentx-engine" "$INSTALL_DIR/agentx-engine" 2>/dev/null || true
  chmod +x "$INSTALL_DIR/agentx" "$INSTALL_DIR/agentx-server"

  # The dashboard is a separate, platform-independent release asset (built by AgentX-web-front's
  # own CI against its private source, see that repo's publish-selfhost-web.yml workflow and this
  # repo's README's "Dashboard release") rather than bundled into the tarball above. Ships as a
  # plain sibling directory next to agentx-engine, not embedded in it, see engine/src/web.ts's
  # findWebIndexHtml for why and where it looks.
  local web_url
  if [ "$version" = "latest" ]; then
    web_url="https://github.com/${REPO}/releases/latest/download/agentx-web.tar.gz"
  else
    web_url="https://github.com/${REPO}/releases/download/${version}/agentx-web.tar.gz"
  fi
  # Unpacked into the temp directory first and only swapped in once that succeeded. Deleting
  # $INSTALL_DIR/web up front meant a re-run on a flaky network - or against a release that has no
  # dashboard asset yet - left an existing, working dashboard deleted and replaced with an empty
  # directory, turning a failed upgrade into a broken install.
  if curl -fsSL "$web_url" -o "$tmp_dir/agentx-web.tar.gz"; then
    mkdir -p "$tmp_dir/web"
    tar -xzf "$tmp_dir/agentx-web.tar.gz" -C "$tmp_dir/web"
    rm -rf "$INSTALL_DIR/web"
    mv "$tmp_dir/web" "$INSTALL_DIR/web"
  else
    echo "warning: no dashboard bundle found at $web_url, keeping any previously installed dashboard" >&2
  fi

  echo "Installed to $INSTALL_DIR"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      echo ""
      echo "Add it to your PATH:"
      echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
      echo ""
      echo "Add that line to your shell profile (~/.zshrc, ~/.bashrc, etc.) to keep it."
      ;;
  esac

  echo ""
  echo "Run 'agentx-server --dev' to start the governance layer locally."
}

main "$@"
