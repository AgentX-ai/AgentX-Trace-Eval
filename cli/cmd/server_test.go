package cmd

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The CLI is a launcher: everything it does is decide WHICH engine to run and with what. Getting
// that decision wrong is not a crash, it is `agentx-server --dev` starting the wrong thing, or a
// confusing "could not find a governance engine" on a perfectly good checkout.

func TestBuildEngineCommandPrefersExplicitOverride(t *testing.T) {
	cmd, err := buildEngineCommand(serverOptions{engine: "/opt/custom/agentx-engine"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd.Path != "/opt/custom/agentx-engine" {
		t.Fatalf("got engine path %q, want the override", cmd.Path)
	}
	if len(cmd.Args) != 1 {
		t.Fatalf("got args %v, want no extra args without --dev", cmd.Args)
	}
}

func TestBuildEngineCommandPassesDevThrough(t *testing.T) {
	cmd, err := buildEngineCommand(serverOptions{engine: "/opt/custom/agentx-engine", dev: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cmd.Args) != 2 || cmd.Args[1] != "--dev" {
		t.Fatalf("got args %v, want [engine --dev]", cmd.Args)
	}
}

// The override wins over a bundled binary sitting next to the executable, which is what makes
// --engine-bin usable for testing a build without moving files around.
func TestBuildEngineCommandOverrideBeatsBundled(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("cannot resolve the test executable: %v", err)
	}
	bundled := filepath.Join(filepath.Dir(exe), "agentx-engine")
	if err := os.WriteFile(bundled, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Skipf("cannot write a fake bundled engine: %v", err)
	}
	defer os.Remove(bundled)

	cmd, err := buildEngineCommand(serverOptions{engine: "/opt/custom/agentx-engine"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd.Path != "/opt/custom/agentx-engine" {
		t.Fatalf("got %q, want the override to win over the bundled binary", cmd.Path)
	}
}

func TestBuildEngineCommandFindsABundledEngine(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("cannot resolve the test executable: %v", err)
	}
	bundled := filepath.Join(filepath.Dir(exe), "agentx-engine")
	if _, statErr := os.Stat(bundled); statErr == nil {
		t.Skip("a real agentx-engine already sits next to the test binary")
	}
	if err := os.WriteFile(bundled, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Skipf("cannot write a fake bundled engine: %v", err)
	}
	defer os.Remove(bundled)

	cmd, err := buildEngineCommand(serverOptions{dev: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd.Path != bundled {
		t.Fatalf("got %q, want the bundled binary at %q", cmd.Path, bundled)
	}
	if len(cmd.Args) != 2 || cmd.Args[1] != "--dev" {
		t.Fatalf("got args %v, want --dev forwarded to the bundled engine", cmd.Args)
	}
}

// A directory that is not a bundled engine must not be mistaken for one.
func TestBuildEngineCommandIgnoresADirectoryNamedLikeTheEngine(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("cannot resolve the test executable: %v", err)
	}
	bundled := filepath.Join(filepath.Dir(exe), "agentx-engine")
	if _, statErr := os.Stat(bundled); statErr == nil {
		t.Skip("something already occupies the bundled-engine path")
	}
	if err := os.Mkdir(bundled, 0o755); err != nil {
		t.Skipf("cannot create the directory: %v", err)
	}
	defer os.RemoveAll(bundled)

	cmd, err := buildEngineCommand(serverOptions{})
	// Either it falls through to the source checkout or it reports no engine - what it must not do
	// is try to execute a directory.
	if err == nil && cmd.Path == bundled {
		t.Fatalf("a directory was selected as the engine binary")
	}
}

func TestBuildEngineCommandFallsBackToTheSourceCheckout(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "engine"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "engine", "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	chdir(t, dir)

	cmd, err := buildEngineCommand(serverOptions{dev: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if filepath.Base(cmd.Path) != "yarn" {
		t.Fatalf("got %q, want yarn for a source checkout", cmd.Path)
	}
	// `yarn dev -- --dev`: the bare -- is what gets --dev past yarn to the engine itself.
	if strings.Join(cmd.Args[1:], " ") != "dev -- --dev" {
		t.Fatalf("got args %v, want [dev -- --dev]", cmd.Args[1:])
	}
	if cmd.Dir != filepath.Join(dir, "engine") {
		t.Fatalf("got working dir %q, want the engine directory", cmd.Dir)
	}
}

func TestBuildEngineCommandReportsWhenNothingIsFound(t *testing.T) {
	exe, err := os.Executable()
	if err == nil {
		if _, statErr := os.Stat(filepath.Join(filepath.Dir(exe), "agentx-engine")); statErr == nil {
			t.Skip("a bundled engine exists next to the test binary")
		}
	}
	chdir(t, t.TempDir())

	if _, err := buildEngineCommand(serverOptions{}); err == nil {
		t.Fatal("expected an error when no engine can be found")
	} else if !strings.Contains(err.Error(), "engine") {
		t.Fatalf("error %q does not mention the engine, so it will not tell the user what to do", err)
	}
}

func TestFindSourceEngineDirWalksUp(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "engine"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "engine", "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	chdir(t, deep)

	got, err := findSourceEngineDir()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// macOS resolves TempDir through /private, so compare resolved paths.
	want, _ := filepath.EvalSymlinks(filepath.Join(root, "engine"))
	gotResolved, _ := filepath.EvalSymlinks(got)
	if gotResolved != want {
		t.Fatalf("got %q, want %q", gotResolved, want)
	}
}

func TestFindSourceEngineDirStopsAtTheRoot(t *testing.T) {
	chdir(t, t.TempDir())
	if _, err := findSourceEngineDir(); err == nil {
		t.Fatal("expected an error when there is no engine/ anywhere above the working directory")
	}
}

func TestDevFlag(t *testing.T) {
	if got := devFlag(true); len(got) != 1 || got[0] != "--dev" {
		t.Fatalf("devFlag(true) = %v", got)
	}
	if got := devFlag(false); len(got) != 0 {
		t.Fatalf("devFlag(false) = %v, want empty", got)
	}
}

func TestWaitForHealthReturnsTrueOnceHealthy(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		if hits < 3 {
			// The engine is still booting - exactly what the retry loop is for.
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if !waitForHealth(srv.URL+"/health", 10*time.Second) {
		t.Fatal("waitForHealth gave up on an engine that came up on the third try")
	}
}

func TestWaitForHealthGivesUpWithinTheTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	started := time.Now()
	if waitForHealth(srv.URL+"/health", 900*time.Millisecond) {
		t.Fatal("waitForHealth reported healthy for a server that only ever 500s")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("waitForHealth overran its timeout by a lot: %v", elapsed)
	}
}

func TestWaitForHealthHandlesAnUnreachableEngine(t *testing.T) {
	// Nothing is listening on port 1; this must fail fast rather than hang the --dev browser open.
	if waitForHealth("http://127.0.0.1:1/health", 700*time.Millisecond) {
		t.Fatal("waitForHealth reported healthy against a closed port")
	}
}

// chdir changes the working directory for one test and restores it afterwards. t.Chdir exists in
// newer Go releases; this keeps the tests runnable on the version the module declares.
func chdir(t *testing.T, dir string) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
}
