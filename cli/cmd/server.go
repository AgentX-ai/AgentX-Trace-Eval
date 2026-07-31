// Package cmd implements agentx-server's subcommands: right now just the process-supervisor
// role described in the plan. Locate the governance engine, launch it, wait for it to come up,
// open the browser in --dev mode, forward signals for clean shutdown.
package cmd

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

type serverOptions struct {
	dev    bool
	port   string
	dbURL  string
	engine string
}

// RunServer is agentx-server's entrypoint (also reachable as `agentx server`, see main.go's
// binary-name dispatch). It does not implement Evaluate/Monitor/Trace itself: that's the
// TypeScript engine (see /engine); this is purely the launcher.
func RunServer(args []string) int {
	fs := flag.NewFlagSet("agentx-server", flag.ExitOnError)
	dev := fs.Bool("dev", false, "run in local development mode: local SQLite DB, opens the dashboard in your browser")
	port := fs.String("port", "4700", "port for the governance engine's HTTP API")
	dbURL := fs.String("db-url", "", "database URL (e.g. postgres://...); defaults to a local SQLite file under ~/.agentx")
	engineOverride := fs.String("engine-bin", "", "path to the engine binary/entrypoint (overrides auto-detection)")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	opts := serverOptions{dev: *dev, port: *port, dbURL: *dbURL, engine: *engineOverride}

	cmd, err := buildEngineCommand(opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "agentx-server:", err)
		return 1
	}

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), fmt.Sprintf("PORT=%s", opts.port))
	if opts.dbURL != "" {
		cmd.Env = append(cmd.Env, fmt.Sprintf("AGENTX_DB_URL=%s", opts.dbURL))
	}

	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "agentx-server: failed to start engine:", err)
		return 1
	}

	// Forward interrupt/terminate to the engine process instead of leaving it orphaned.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
	}()

	if opts.dev {
		go func() {
			url := fmt.Sprintf("http://localhost:%s", opts.port)
			if waitForHealth(url+"/health", 30*time.Second) {
				openBrowser(url)
			}
		}()
	}

	if err := cmd.Wait(); err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return cmd.ProcessState.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "agentx-server:", err)
		return 1
	}
	return 0
}

// buildEngineCommand locates the governance engine and returns an unstarted exec.Cmd for it.
// Tries, in order: an explicit override, a bundled compiled binary next to this executable (the
// eventual `bun build --compile` artifact, plan task #113, not built yet), then a source
// checkout's engine/ directory run via `yarn dev` (this is what makes `agentx-server --dev` work
// today, straight out of the repo, ahead of the compiled binary existing).
func buildEngineCommand(opts serverOptions) (*exec.Cmd, error) {
	if opts.engine != "" {
		return exec.Command(opts.engine, devFlag(opts.dev)...), nil
	}

	if exe, err := os.Executable(); err == nil {
		bundled := filepath.Join(filepath.Dir(exe), "agentx-engine")
		if info, statErr := os.Stat(bundled); statErr == nil && !info.IsDir() {
			return exec.Command(bundled, devFlag(opts.dev)...), nil
		}
	}

	if engineDir, err := findSourceEngineDir(); err == nil {
		args := append([]string{"dev", "--"}, devFlag(opts.dev)...)
		cmd := exec.Command("yarn", args...)
		cmd.Dir = engineDir
		return cmd, nil
	}

	return nil, fmt.Errorf(
		"could not find a governance engine to run. Build one with `bun build --compile` " +
			"in engine/, or run from within the agentx source checkout so engine/ can be found",
	)
}

func devFlag(dev bool) []string {
	if dev {
		return []string{"--dev"}
	}
	return nil
}

// findSourceEngineDir walks up from the CLI binary's working directory looking for a sibling
// engine/package.json, true when running via `go run ./cli` (or `go build` + execute) from
// within a checkout of this repo.
func findSourceEngineDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := wd
	for {
		candidate := filepath.Join(dir, "engine", "package.json")
		if _, err := os.Stat(candidate); err == nil {
			return filepath.Join(dir, "engine"), nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no engine/ found above %s", wd)
		}
		dir = parent
	}
}

func waitForHealth(url string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	client := http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return true
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
