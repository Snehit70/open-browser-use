package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type scrollCall struct {
	method string
	params map[string]any
}

// scrollFake answers page-state evaluations with state(wheels), lists tab 5
// with the given origin, and records every CDP call.
func scrollFake(t *testing.T, origin string, state func(wheels int) map[string]any) (string, *[]float64, *[]scrollCall) {
	return scrollFakeWithNudge(t, origin, state, nil)
}

func nudgeDelta(expression string) int {
	open := strings.LastIndex(expression, "(")
	dy, _ := strconv.Atoi(strings.TrimSuffix(expression[open+1:], ")"))
	return dy
}

// scrollFakeWithNudge also answers the scrollBy fallback: nudge() reports
// whether the page found something to scroll.
func scrollFakeWithNudge(t *testing.T, origin string, state func(wheels int) map[string]any, nudge func(dy int) bool) (string, *[]float64, *[]scrollCall) {
	t.Helper()
	var deltas []float64
	var calls []scrollCall
	socketPath, _ := fakeExtensionSocket(t, func(method string, params map[string]any, _ int) map[string]any {
		if method == "getTabs" {
			return map[string]any{"result": []any{map[string]any{"id": 5.0, "origin": origin}}}
		}
		if method != "executeCdp" {
			return map[string]any{"result": nil}
		}
		commandParams, _ := params["commandParams"].(map[string]any)
		calls = append(calls, scrollCall{params["method"].(string), commandParams})
		switch params["method"] {
		case "Input.dispatchMouseEvent":
			deltas = append(deltas, commandParams["deltaY"].(float64))
		case "Runtime.evaluate":
			if expression, _ := commandParams["expression"].(string); strings.Contains(expression, "best.scrollBy") {
				value := nudge != nil && nudge(nudgeDelta(expression))
				return map[string]any{"result": map[string]any{"result": map[string]any{"value": value}}}
			}
			return map[string]any{"result": map[string]any{"result": map[string]any{"value": state(len(deltas))}}}
		}
		return map[string]any{"result": map[string]any{}}
	})
	return socketPath, &deltas, &calls
}

func page(positions map[string]any, height float64) map[string]any {
	labels := map[string]any{}
	for id := range positions {
		labels[id] = "el" + id
	}
	return map[string]any{"positions": positions, "labels": labels, "height": height, "viewport": []any{800.0, 600.0}}
}

func scrollArgs(socketPath string, extra ...string) []string {
	return append([]string{"scroll", "--socket", socketPath, "--session-id", "t", "--tab-id", "5", "--wait-ms", "0"}, extra...)
}

func TestScrollStopsWhenNothingMoves(t *testing.T) {
	socketPath, deltas, _ := scrollFake(t, "agent", func(int) map[string]any {
		s := page(map[string]any{"1": 4000.0}, 5000)
		s["count"] = 1.0
		return s
	})
	if err := run(scrollArgs(socketPath, "--selector", "article", "--until-count", "50", "--times", "5")); err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 1 {
		t.Fatalf("a stuck feed should stop after one step, got %d wheels", len(*deltas))
	}
}

// A small nested box at the viewport center tops out after one step while the
// page keeps scrolling; the scroll must carry on.
func TestScrollContinuesPastNestedBox(t *testing.T) {
	socketPath, deltas, _ := scrollFake(t, "agent", func(wheels int) map[string]any {
		box := float64(min(wheels, 1) * 100)
		return page(map[string]any{"1": float64(wheels) * 500, "2": box}, 9000)
	})
	if err := run(scrollArgs(socketPath, "--times", "4")); err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 4 {
		t.Fatalf("page still moving: want 4 wheels, got %d", len(*deltas))
	}
}

func TestScrollContinuesWhilePageGrows(t *testing.T) {
	socketPath, deltas, _ := scrollFake(t, "agent", func(wheels int) map[string]any {
		return page(map[string]any{"1": 4000.0}, 5000+float64(wheels)*1000)
	})
	if err := run(scrollArgs(socketPath, "--times", "3")); err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 3 {
		t.Fatalf("growing page: want 3 wheels, got %d", len(*deltas))
	}
}

func TestScrollStopsAtUntilCount(t *testing.T) {
	socketPath, deltas, _ := scrollFake(t, "agent", func(wheels int) map[string]any {
		s := page(map[string]any{"1": float64(wheels) * 500}, 9000)
		s["count"] = float64(5 + wheels*5)
		return s
	})
	if err := run(scrollArgs(socketPath, "--selector", "article", "--until-count", "20", "--times", "10")); err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 3 {
		t.Fatalf("5 items +5 per step should reach 20 in 3 steps, got %d", len(*deltas))
	}
}

func TestScrollUpStopsAtTop(t *testing.T) {
	socketPath, deltas, _ := scrollFake(t, "agent", func(wheels int) map[string]any {
		return page(map[string]any{"1": float64(max(1000-wheels*500, 0))}, 9000)
	})
	if err := run(scrollArgs(socketPath, "--pixels", "-500", "--times", "10")); err != nil {
		t.Fatal(err)
	}
	// 1000 -> 500 -> 0 move; the third wheel finds nothing left.
	if len(*deltas) != 3 || (*deltas)[0] != -500 {
		t.Fatalf("want 3 upward wheels of -500, got %v", *deltas)
	}
}

func TestScrollRejectsZeroPixels(t *testing.T) {
	socketPath, deltas, _ := scrollFake(t, "agent", func(int) map[string]any { return page(map[string]any{"1": 0.0}, 9000) })
	if err := run(scrollArgs(socketPath, "--pixels", "0")); err == nil {
		t.Fatal("--pixels 0 should be rejected")
	}
	if len(*deltas) != 0 {
		t.Fatalf("no wheel should be sent, got %v", *deltas)
	}
}

// When the center of the tab is an iframe, nothing measurable moves; scroll
// must keep going (as before this change) rather than report the end.
func TestScrollKeepsGoingOverOpaqueFrame(t *testing.T) {
	nudges := 0
	socketPath, deltas, _ := scrollFakeWithNudge(t, "agent", func(int) map[string]any {
		s := page(map[string]any{"1": 0.0}, 900)
		s["opaque"] = true
		s["roomDown"] = true
		return s
	}, func(int) bool { nudges++; return true })
	if err := run(scrollArgs(socketPath, "--times", "4")); err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 4 || nudges != 0 {
		t.Fatalf("want 4 wheels and no scrollBy fallback, got %d wheels, %d nudges", len(*deltas), nudges)
	}
}

// The page scripts are only exercised in a browser; at least make sure they parse.
func TestScrollScriptsParse(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	path := filepath.Join(t.TempDir(), "scripts.js")
	source := "const a = " + scrollStateScript + ";\nconst b = " + scrollNudgeScript + ";\n"
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(node, "--check", path).CombinedOutput(); err != nil {
		t.Fatalf("page scripts do not parse: %v\n%s", err, out)
	}
}

func TestScrollUntilCountNeedsSelector(t *testing.T) {
	socketPath, _, _ := scrollFake(t, "agent", func(int) map[string]any { return map[string]any{} })
	if err := run(scrollArgs(socketPath, "--until-count", "3")); err == nil {
		t.Fatal("--until-count without --selector should fail")
	}
}

func focusEmulationCalls(calls []scrollCall) []bool {
	var out []bool
	for _, call := range calls {
		if call.method == "Emulation.setFocusEmulationEnabled" {
			out = append(out, call.params["enabled"].(bool))
		}
	}
	return out
}

func TestScrollRestoresFocusOnUserTab(t *testing.T) {
	socketPath, _, calls := scrollFake(t, "user", func(int) map[string]any { return page(map[string]any{"1": 0.0}, 100) })
	if err := run(scrollArgs(socketPath)); err != nil {
		t.Fatal(err)
	}
	if got := focusEmulationCalls(*calls); len(got) != 2 || !got[0] || got[1] {
		t.Fatalf("user tab: want emulation on then off, got %v", got)
	}
}

func TestScrollKeepsFocusOnAgentTab(t *testing.T) {
	socketPath, _, calls := scrollFake(t, "agent", func(int) map[string]any { return page(map[string]any{"1": 0.0}, 100) })
	if err := run(scrollArgs(socketPath)); err != nil {
		t.Fatal(err)
	}
	if got := focusEmulationCalls(*calls); len(got) != 1 || !got[0] {
		t.Fatalf("agent tab: want emulation left on, got %v", got)
	}
}

// A fixed box at the viewport center swallows the wheel and the page never
// moves; scroll falls back to scrollBy on the page and keeps going.
func TestScrollFallsBackToScrollByWhenWheelIsSwallowed(t *testing.T) {
	nudges := 0
	socketPath, deltas, _ := scrollFakeWithNudge(t, "agent", func(int) map[string]any {
		return page(map[string]any{"1": float64(nudges) * 500, "2": 100.0}, 9000)
	}, func(int) bool { nudges++; return true })
	if err := run(scrollArgs(socketPath, "--times", "4")); err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 1 || nudges != 4 {
		t.Fatalf("want 1 wheel then scrollBy for every step (4), got %d wheels, %d nudges", len(*deltas), nudges)
	}
}

// In scrollBy mode an instant jump to the bottom can leave a lazy loader
// unaware; scroll steps back up and down once before deciding it hit the end.
func TestScrollByStepsBackBeforeGivingUp(t *testing.T) {
	var nudges []int
	stepBacks := 0
	socketPath, _, _ := scrollFakeWithNudge(t, "agent", func(int) map[string]any {
		s := page(map[string]any{"1": 4000.0, "2": 100.0}, 5000+float64(stepBacks)*1000)
		s["count"] = float64(10 + stepBacks*10)
		return s
	}, func(dy int) bool {
		nudges = append(nudges, dy)
		if dy < 0 && stepBacks < 2 {
			stepBacks++
		}
		return true
	})
	if err := run(scrollArgs(socketPath, "--selector", "article", "--times", "10")); err != nil {
		t.Fatal(err)
	}
	if stepBacks != 2 {
		t.Fatalf("want the step-back to load twice, got %d (nudges %v)", stepBacks, nudges)
	}
	if nudges[len(nudges)-1] != 2000 || nudges[len(nudges)-2] != -2000 {
		t.Fatalf("a step back should be followed by a step down, got %v", nudges)
	}
}

// An iframe at the center once the page has reached its end (an embed at the
// bottom of an article) must not keep the scroll going.
func TestScrollStopsOverOpaqueFrameAtPageEnd(t *testing.T) {
	socketPath, deltas, _ := scrollFake(t, "agent", func(int) map[string]any {
		s := page(map[string]any{"1": 3000.0}, 4000)
		s["opaque"] = true
		s["roomDown"] = false
		s["pageScrolls"] = true
		return s
	})
	if err := run(scrollArgs(socketPath, "--times", "6")); err != nil {
		t.Fatal(err)
	}
	if len(*deltas) != 1 {
		t.Fatalf("page at its end: want 1 wheel, got %d", len(*deltas))
	}
}
