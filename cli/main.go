// agentx / agentx-server: the Go CLI/installer/process-supervisor for AgentX's self-host
// governance layer. Deliberately thin: it launches and manages the TypeScript engine (see
// /engine), it does not reimplement Evaluate/Monitor/Trace itself (see the plan's language
// decision: Go for the shell, TypeScript for the engine).
//
// One binary answers to two names: invoked as `agentx-server`, it goes straight into the server
// subcommand (so `agentx-server --dev` works exactly as specified); invoked as `agentx`, the
// first argument selects the subcommand (`agentx server --dev`, with more subcommands like
// `agentx login`/`agentx init` to follow as the project grows).
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/AgentX-ai/AgentX-SelfHosted/cli/cmd"
)

func main() {
	os.Exit(run(os.Args))
}

func run(argv []string) int {
	binName := strings.TrimSuffix(filepath.Base(argv[0]), ".exe")
	args := argv[1:]

	if binName == "agentx-server" {
		return cmd.RunServer(args)
	}

	if len(args) == 0 {
		printUsage()
		return 1
	}

	switch args[0] {
	case "server":
		return cmd.RunServer(args[1:])
	case "help", "-h", "--help":
		printUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "agentx: unknown command %q\n\n", args[0])
		printUsage()
		return 1
	}
}

func printUsage() {
	fmt.Println(`agentx: the AgentX self-host governance layer (Evaluate, Monitor, Trace)

Usage:
  agentx server [--dev] [--port 4700] [--db-url postgres://...]
  agentx-server [--dev] [--port 4700] [--db-url postgres://...]

  --dev   run locally against SQLite and open the dashboard in your browser`)
}
