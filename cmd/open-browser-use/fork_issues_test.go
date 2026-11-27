package main

import (
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// A host that shows up a moment after the command starts (the extension's
// service worker restarting) is found instead of failing with "no Chrome host
// was reachable".
func TestDialRetriesUntilHostAppears(t *testing.T) {
	socketDir := t.TempDir()
	sock := filepath.Join(socketDir, "late.sock")
	go func() {
		time.Sleep(700 * time.Millisecond)
		listener, err := net.Listen("unix", sock)
		if err != nil {
			return
		}
		defer listener.Close()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				var request map[string]any
				if err := wire.ReadJSON(conn, &request); err != nil {
					return
				}
				_ = wire.WriteJSON(conn, map[string]any{
					"jsonrpc": "2.0",
					"id":      request["id"],
					"result":  map[string]any{"metadata": map[string]any{"extensionInstanceId": "inst-late"}},
				})
				time.Sleep(200 * time.Millisecond)
			}(conn)
		}
	}()
	conn, err := dialBrowserSocketForProfile("", socketDir, "", "inst-late", 5*time.Second)
	if err != nil {
		t.Fatalf("want the late host to be found, got %v", err)
	}
	conn.Close()
}

// startFakeHost answers getInfo on sock after delay, as instance.
func startFakeHost(t *testing.T, sock string, instance string, delay time.Duration) {
	t.Helper()
	ready := make(chan net.Listener, 1)
	go func() {
		time.Sleep(delay)
		listener, err := net.Listen("unix", sock)
		if err != nil {
			ready <- nil
			return
		}
		ready <- listener
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				var request map[string]any
				if err := wire.ReadJSON(conn, &request); err != nil {
					return
				}
				_ = wire.WriteJSON(conn, map[string]any{
					"jsonrpc": "2.0",
					"id":      request["id"],
					"result":  map[string]any{"metadata": map[string]any{"extensionInstanceId": instance}},
				})
				time.Sleep(200 * time.Millisecond)
			}(conn)
		}
	}()
	t.Cleanup(func() {
		select {
		case listener := <-ready:
			if listener != nil {
				listener.Close()
			}
		case <-time.After(2 * time.Second):
		}
	})
}

// Hosts that answer but match no --profile: a wrong selector fails after a
// short wait, not most of --timeout.
func TestDialMismatchWaitsBriefly(t *testing.T) {
	socketDir := t.TempDir()
	startFakeHost(t, filepath.Join(socketDir, "a.sock"), "inst-a", 0)
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	_, err := dialBrowserSocketForProfile("", socketDir, "", "inst-nope", 30*time.Second)
	if err == nil || !strings.Contains(err.Error(), "currently connected") {
		t.Fatalf("want a mismatch error listing connected hosts, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > noSocketRetryBudget+time.Second {
		t.Fatalf("mismatch wait should stay near %s, took %s", noSocketRetryBudget, elapsed)
	}
}

// Another profile's host keeps answering while the target profile's host
// restarts (its socket is gone meanwhile): the CLI waits for it.
func TestDialWaitsForRestartingProfileBesideAnother(t *testing.T) {
	socketDir := t.TempDir()
	startFakeHost(t, filepath.Join(socketDir, "a.sock"), "inst-a", 0)
	startFakeHost(t, filepath.Join(socketDir, "b.sock"), "inst-b", 1500*time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	conn, err := dialBrowserSocketForProfile("", socketDir, "", "inst-b", 10*time.Second)
	if err != nil {
		t.Fatalf("want the restarting profile to be found, got %v", err)
	}
	conn.Close()
}

// Without --browser/--profile the CLI also waits for a restarting host.
func TestDialDefaultPathRetries(t *testing.T) {
	socketDir := t.TempDir()
	startFakeHost(t, filepath.Join(socketDir, "late.sock"), "inst-late", 700*time.Millisecond)
	conn, err := dialBrowserSocketForProfile("", socketDir, "", "", 5*time.Second)
	if err != nil {
		t.Fatalf("want the late host to be found on the default path, got %v", err)
	}
	conn.Close()
}

// A closed browser (no socket at all) fails within a few seconds even with a
// long --timeout.
func TestDialNoSocketWaitsBriefly(t *testing.T) {
	start := time.Now()
	_, err := dialBrowserSocketForProfile("", t.TempDir(), "", "nobody", 30*time.Second)
	if err == nil {
		t.Fatal("want an error")
	}
	if elapsed := time.Since(start); elapsed > noSocketRetryBudget+time.Second {
		t.Fatalf("no-socket wait should stay near %s, took %s", noSocketRetryBudget, elapsed)
	}
}

func TestDialGivesUpWithinBudget(t *testing.T) {
	start := time.Now()
	_, err := dialBrowserSocketForProfile("", t.TempDir(), "", "nobody", time.Second)
	if err == nil || !strings.Contains(err.Error(), "kept retrying") {
		t.Fatalf("want a retry note in the error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("discovery should stop within its budget, took %s", elapsed)
	}
}

func TestTimeoutHintWarnsAboutSideEffects(t *testing.T) {
	hint := timeoutRetryHint("executeCdp", map[string]any{"method": "Input.dispatchMouseEvent"})
	if !strings.Contains(hint, "may already have run") {
		t.Fatalf("input commands must warn before retrying, got %q", hint)
	}
	if hint := timeoutRetryHint("getTabs", map[string]any{}); strings.Contains(hint, "already have run") {
		t.Fatalf("read-only calls need no warning, got %q", hint)
	}
}

func TestParseKeyChord(t *testing.T) {
	cases := []struct {
		spec      string
		key, code string
		keyCode   int
		modifiers int
		text      string
	}{
		{"ctrl+h", "h", "KeyH", 72, modCtrl, ""},
		{"shift+End", "End", "End", 35, modShift, ""},
		{"Home", "Home", "Home", 36, 0, ""},
		{"a", "a", "KeyA", 65, 0, "a"},
		{"A", "A", "KeyA", 65, modShift, "A"},
		{"ctrl+shift+z", "Z", "KeyZ", 90, modCtrl | modShift, ""},
		{"Enter", "Enter", "Enter", 13, 0, "\r"},
		{"F5", "F5", "F5", 116, 0, ""},
		{"ctrl++", "+", "", 0, modCtrl, ""},
		{"+", "+", "", 0, 0, "+"},
		{"Ctrl+H", "h", "KeyH", 72, modCtrl, ""},
		{"ctrl+A", "a", "KeyA", 65, modCtrl, ""},
		{"Ctrl+Shift+Z", "Z", "KeyZ", 90, modCtrl | modShift, ""},
	}
	for _, c := range cases {
		got, err := parseKeyChord(c.spec)
		if err != nil {
			t.Fatalf("%s: %v", c.spec, err)
		}
		if got.key != c.key || got.code != c.code || got.keyCode != c.keyCode || got.modifiers != c.modifiers || got.text != c.text {
			t.Fatalf("%s: got %+v", c.spec, got)
		}
	}
	for _, bad := range []string{"hyper+a", "ctrl+", "NoSuchKey"} {
		if _, err := parseKeyChord(bad); err == nil {
			t.Fatalf("%s: want an error", bad)
		}
	}
}

func TestWithoutArgsKeepsPositionals(t *testing.T) {
	args := withoutArgs([]string{"--new-window", "https://example.com"}, "--new-window")
	if got := firstStringArg(args, "--url"); got != "https://example.com" {
		t.Fatalf("URL after a boolean flag was lost: %q", got)
	}
}

func TestLinkOpensNewTab(t *testing.T) {
	for target, want := range map[string]bool{"": false, "_self": false, "_top": false, "_blank": true, "_BLANK": true, "preview": false} {
		if got := linkOpensNewTab(map[string]any{"target": target}); got != want {
			t.Fatalf("target %q: got %v", target, got)
		}
	}
}
