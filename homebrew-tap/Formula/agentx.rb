# Custom tap formula (avoids any collision with an unrelated "agentx" formula in homebrew-core):
#
#   brew tap AgentX-ai/tap
#   brew install agentx
#
# Builds the Go CLI from source. The engine (TypeScript, compiled separately via
# `bun build --compile`, see plan task #113) ships as a prebuilt binary asset attached to the
# GitHub release this formula points at, not built by Homebrew itself.
class Agentx < Formula
  desc "Self-hostable AgentX governance layer: Evaluate, Monitor, and Trace for AI agents"
  homepage "https://github.com/AgentX-ai/AgentX-trace-eval"
  url "https://github.com/AgentX-ai/AgentX-trace-eval/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "" # filled in per release
  license "Apache-2.0"

  depends_on "go" => :build

  def install
    cd "cli" do
      system "go", "build", *std_go_args(output: bin/"agentx", ldflags: "-s -w")
    end
    # `agentx-server` is the same binary under a second name (see cli/main.go's
    # filepath.Base(os.Args[0]) dispatch) so `agentx-server --dev` works exactly as documented.
    bin.install_symlink "agentx" => "agentx-server"

    # Prebuilt engine binary for this platform, downloaded from the matching GitHub release
    # rather than built here (Bun isn't a Homebrew build dependency for this formula).
    system "curl", "-fsSL",
           "https://github.com/AgentX-ai/AgentX-trace-eval/releases/download/v0.1.0/agentx-engine_#{OS.mac? ? "darwin" : "linux"}_#{Hardware::CPU.arm? ? "arm64" : "amd64"}",
           "-o", bin/"agentx-engine"
    chmod 0755, bin/"agentx-engine"

    # The dashboard is a separate, platform-independent release asset (built by
    # AgentX-web-front's own private CI, see that repo's publish-selfhost-web.yml workflow and
    # this repo's README's "Dashboard release") rather than committed source in this repo, so
    # it's downloaded here instead of `(bin/"web").install`-ed from this formula's own source
    # tarball. Ships as a plain directory next to agentx-engine (engine/src/web.ts's
    # findWebIndexHtml looks in agentx-engine's own directory first), not embedded in the binary.
    (bin/"web").mkpath
    system "curl", "-fsSL",
           "https://github.com/AgentX-ai/AgentX-trace-eval/releases/download/v0.1.0/agentx-web.tar.gz",
           "-o", "agentx-web.tar.gz"
    system "tar", "-xzf", "agentx-web.tar.gz", "-C", bin/"web"
  end

  test do
    assert_match "agentx", shell_output("#{bin}/agentx help")
  end
end
