package main

import (
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The engine stand-in for dispatch tests: `true` looked up on PATH rather than a hardcoded
// /bin/true, which does not exist on macOS (it lives in /usr/bin there).
func trueBin(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("true")
	if err != nil {
		t.Skip("no `true` binary on PATH")
	}
	return path
}

// One binary answers to two names, and which name it was invoked under decides whether the first
// argument is a subcommand or a flag. Getting that wrong means `agentx-server --dev` reads --dev
// as an unknown command, which is the whole documented entry point in the README.

func TestServerBinaryNameSkipsSubcommandDispatch(t *testing.T) {
	// Dispatched straight into RunServer, so the argument reaching it is --engine-bin, not a
	// subcommand. /bin/true stands in for the engine so nothing real is launched.
	code, out := captureRun(t, []string{"agentx-server", "--engine-bin", trueBin(t)})
	if code != 0 {
		t.Fatalf("exit %d, output: %s", code, out)
	}
	if strings.Contains(out, "unknown command") {
		t.Fatalf("--engine-bin was read as a subcommand: %s", out)
	}
}

func TestServerBinaryNameToleratesTheWindowsSuffix(t *testing.T) {
	// Bare name rather than a C:\... path: filepath.Base only treats backslash as a separator on
	// Windows, so a literal Windows path here would be testing the host's filepath rules, not the
	// suffix trimming this is about.
	code, out := captureRun(t, []string{"agentx-server.exe", "--engine-bin", trueBin(t)})
	if code != 0 {
		t.Fatalf("exit %d, output: %s", code, out)
	}
	if strings.Contains(out, "unknown command") {
		t.Fatalf(".exe suffix broke the binary-name dispatch: %s", out)
	}
}

func TestServerBinaryNameWorksFromAnAbsolutePath(t *testing.T) {
	code, out := captureRun(t, []string{"/usr/local/bin/agentx-server", "--engine-bin", trueBin(t)})
	if code != 0 {
		t.Fatalf("exit %d, output: %s", code, out)
	}
	if strings.Contains(out, "unknown command") {
		t.Fatalf("an absolute path broke the binary-name dispatch: %s", out)
	}
}

func TestAgentxServerSubcommand(t *testing.T) {
	code, out := captureRun(t, []string{"agentx", "server", "--engine-bin", trueBin(t)})
	if code != 0 {
		t.Fatalf("exit %d, output: %s", code, out)
	}
	if strings.Contains(out, "unknown command") {
		t.Fatalf("`agentx server` was not dispatched: %s", out)
	}
}

func TestAgentxWithNoArgumentsPrintsUsageAndFails(t *testing.T) {
	code, out := captureRun(t, []string{"agentx"})
	if code == 0 {
		t.Fatal("no arguments should be an error exit, so a shell script notices")
	}
	if !strings.Contains(out, "Usage:") {
		t.Fatalf("usage was not printed: %s", out)
	}
}

func TestAgentxHelpSucceeds(t *testing.T) {
	for _, arg := range []string{"help", "-h", "--help"} {
		code, out := captureRun(t, []string{"agentx", arg})
		if code != 0 {
			t.Fatalf("`agentx %s` exited %d", arg, code)
		}
		if !strings.Contains(out, "agentx server") || !strings.Contains(out, "--dev") {
			t.Fatalf("`agentx %s` usage is missing the documented invocations: %s", arg, out)
		}
	}
}

func TestAgentxUnknownCommandNamesIt(t *testing.T) {
	code, out := captureRun(t, []string{"agentx", "evaluate"})
	if code == 0 {
		t.Fatal("an unknown command should exit non-zero")
	}
	if !strings.Contains(out, "evaluate") {
		t.Fatalf("the error does not name the command the user typed: %s", out)
	}
	if !strings.Contains(out, "Usage:") {
		t.Fatalf("usage was not printed alongside the error: %s", out)
	}
}

// captureRun runs the CLI with stdout+stderr redirected, since everything under test writes to
// them directly.
func captureRun(t *testing.T, argv []string) (int, string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	origOut, origErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = w, w
	done := make(chan string, 1)
	go func() {
		buf, _ := io.ReadAll(r)
		done <- string(buf)
	}()

	code := run(argv)

	os.Stdout, os.Stderr = origOut, origErr
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return code, out
}
