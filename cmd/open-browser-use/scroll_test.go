package main

import (
	"testing"
)

// scrollFake answers page-state evaluations with state(wheels) and counts
// mouseWheel events and their deltas.
func scrollFake(t *testing.T, state func(wheels int) map[string]any) (string, *[]float64) {
	t.Helper()
	var deltas []float64
	socketPath, _ := fakeExtensionSocket(t, func(method string, params map[string]any, _ int) map[string]any {
		if method != "executeCdp" {
			return map[string]any{"result": nil}
		}
		switch params["method"] {
		case "Input.dispatchMouseEvent":
			commandParams := params["commandParams"].(map[string]any)
			deltas = append(deltas, commandParams["deltaY"].(float64))
		case "Runtime.evaluate":
			return map[string]any{"result": map[string]any{"result": map[string]any{"value": state(len(deltas))}}}
		}
		return map[string]any{"result": map[string]any{}}
	})
	return socketPath, &deltas
}

func TestScrollStopsAtBottomEvenWithUntilCount(t *testing.T) {
	socketPath, deltas := scrollFake(t, func(int) map[string]any {
		return map[string]any{"atBottom": true, "atTop": false, "count": 1, "viewport": []any{800.0, 600.0}}
	})
	err := run([]string{"scroll", "--socket", socketPath, "--session-id", "t", "--tab-id", "5",
		"--selector", "article", "--until-count", "50", "--times", "5", "--wait-ms", "0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 1 {
		t.Fatalf("a feed stuck at the bottom should stop after one step, got %d wheels", len(*deltas))
	}
}

func TestScrollStopsAtUntilCount(t *testing.T) {
	socketPath, deltas := scrollFake(t, func(wheels int) map[string]any {
		return map[string]any{"atBottom": false, "atTop": false, "count": 5 + wheels*5, "viewport": []any{800.0, 600.0}}
	})
	err := run([]string{"scroll", "--socket", socketPath, "--session-id", "t", "--tab-id", "5",
		"--selector", "article", "--until-count", "20", "--times", "10", "--wait-ms", "0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 3 {
		t.Fatalf("5 items +5 per step should reach 20 in 3 steps, got %d", len(*deltas))
	}
}

func TestScrollUpStopsAtTop(t *testing.T) {
	socketPath, deltas := scrollFake(t, func(wheels int) map[string]any {
		return map[string]any{"atBottom": false, "atTop": wheels >= 2, "viewport": []any{800.0, 600.0}}
	})
	err := run([]string{"scroll", "--socket", socketPath, "--session-id", "t", "--tab-id", "5",
		"--pixels", "-500", "--times", "10", "--wait-ms", "0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 2 || (*deltas)[0] != -500 {
		t.Fatalf("want 2 upward wheels of -500, got %v", *deltas)
	}
}

func TestScrollUntilCountNeedsSelector(t *testing.T) {
	socketPath, _ := scrollFake(t, func(int) map[string]any { return map[string]any{} })
	err := run([]string{"scroll", "--socket", socketPath, "--session-id", "t", "--tab-id", "5", "--until-count", "3"})
	if err == nil {
		t.Fatal("--until-count without --selector should fail")
	}
}
