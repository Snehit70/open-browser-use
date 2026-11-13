package main

import (
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInvokeTimeoutIsReadable(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "silent.sock")
	listener, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			defer conn.Close()
			time.Sleep(2 * time.Second) // accept but never reply
		}
	}()
	_, err = invokeWithProfile(sock, "", "", "", "getTabs", map[string]any{}, 200*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "no reply from the browser to getTabs within 200ms") || strings.Contains(err.Error(), "i/o timeout") {
		t.Fatalf("want readable timeout error, got %v", err)
	}
}
