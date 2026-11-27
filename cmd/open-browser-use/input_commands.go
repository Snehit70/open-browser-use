package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

// Commands for screenshots, key chords, and paste. Agents used to build these
// from raw cdp calls, which is slow and easy to get wrong in canvas apps such
// as Google Docs.

func newScreenshotCommand() *cobra.Command {
	return newRunnerTabCommand("screenshot", "Save a PNG or JPEG screenshot of a session tab to a file", (*actionRunner).runScreenshotAction,
		func(cmd *cobra.Command) func() []string {
			var out, format string
			var quality int
			cmd.Flags().StringVar(&out, "out", "", "file to write (required); the format follows a .jpg/.jpeg extension unless --format is set")
			cmd.Flags().StringVar(&format, "format", "", "png or jpeg")
			cmd.Flags().IntVar(&quality, "quality", 0, "JPEG quality 1-100")
			return func() []string {
				args := []string{"--out", out}
				if format != "" {
					args = append(args, "--format", format)
				}
				if quality > 0 {
					args = append(args, "--quality", strconv.Itoa(quality))
				}
				return args
			}
		})
}

func newKeyCommand() *cobra.Command {
	return newRunnerTabCommand("key", "Press keys or chords in a session tab, e.g. --keys \"Home shift+End\" or \"ctrl+h\"", (*actionRunner).runKeyAction,
		func(cmd *cobra.Command) func() []string {
			var keys string
			cmd.Flags().StringVar(&keys, "keys", "", "space-separated keys or chords: Enter, Tab, Escape, Home, End, ArrowDown, a, ctrl+h, shift+End, ctrl+shift+z")
			return func() []string { return []string{"--keys", keys} }
		})
}

func newPasteCommand() *cobra.Command {
	return newRunnerTabCommand("paste", "Paste text into the focused element (or --selector) with a paste event, as a user's Ctrl+V would", (*actionRunner).runPasteAction,
		func(cmd *cobra.Command) func() []string {
			var text, textFile, selector string
			cmd.Flags().StringVar(&text, "text", "", "text to paste")
			cmd.Flags().StringVar(&textFile, "text-file", "", "read the text from this file (keeps newlines and avoids shell quoting)")
			cmd.Flags().StringVar(&selector, "selector", "", "CSS selector of the element to paste into; default is the focused element")
			return func() []string {
				args := []string{}
				if text != "" {
					args = append(args, "--text", text)
				}
				if textFile != "" {
					args = append(args, "--text-file", textFile)
				}
				if selector != "" {
					args = append(args, "--selector", selector)
				}
				return args
			}
		})
}

// cdpCall runs one CDP command on tabID and folds a JSON-RPC error into err.
func (runner *actionRunner) cdpCall(tabID int, method string, params map[string]any) (map[string]any, error) {
	response, _, err := runner.invoke("executeCdp", map[string]any{
		"target": tabTarget(tabID, ""), "method": method, "commandParams": params,
		"timeoutMs": cdpTimeoutMs(runner.options.timeout),
	})
	if err == nil {
		err = rpcError(response)
	}
	return response, err
}

func (runner *actionRunner) runScreenshotAction(args []string) (map[string]any, int, error) {
	tabID, err := tabIDArgOrCurrent(args, runner.currentTabID)
	if err != nil {
		return nil, 0, err
	}
	out := stringFlag(args, "--out")
	if out == "" {
		// Run plans: screenshot page.png
		if positionals := positionalArgs(args); len(positionals) > 0 {
			out = positionals[0]
		}
	}
	if out == "" {
		return nil, 0, errors.New("screenshot requires --out FILE")
	}
	format := strings.ToLower(stringFlag(args, "--format"))
	if format == "" {
		format = "png"
		if lower := strings.ToLower(out); strings.HasSuffix(lower, ".jpg") || strings.HasSuffix(lower, ".jpeg") {
			format = "jpeg"
		}
	}
	if format == "jpg" {
		format = "jpeg"
	}
	if format != "png" && format != "jpeg" {
		return nil, 0, fmt.Errorf("screenshot --format must be png or jpeg, not %q", format)
	}
	params := map[string]any{"format": format}
	if quality, ok := intFlag(args, "--quality"); ok && format == "jpeg" {
		params["quality"] = quality
	}
	if err := runner.attachFor(tabID, "Page.captureScreenshot"); err != nil {
		return nil, 0, err
	}
	response, err := runner.cdpCall(tabID, "Page.captureScreenshot", params)
	if err != nil {
		return nil, 0, err
	}
	result, _ := response["result"].(map[string]any)
	data, _ := result["data"].(string)
	image, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(image) == 0 {
		return nil, 0, fmt.Errorf("screenshot: Chrome returned no image data")
	}
	if err := os.WriteFile(out, image, 0o644); err != nil {
		return nil, 0, err
	}
	summary := map[string]any{"out": out, "bytes": len(image), "format": format}
	if fallback, ok := result["fallback"]; ok {
		summary["fallback"] = fallback
	}
	return map[string]any{"result": summary}, tabID, nil
}

// keyChord is one parsed key press such as ctrl+shift+z.
type keyChord struct {
	key       string
	code      string
	keyCode   int
	text      string
	modifiers int
}

// CDP modifier bits.
const (
	modAlt   = 1
	modCtrl  = 2
	modMeta  = 4
	modShift = 8
)

var namedKeys = map[string]struct {
	key, code string
	keyCode   int
	text      string
}{
	"enter":      {"Enter", "Enter", 13, "\r"},
	"tab":        {"Tab", "Tab", 9, ""},
	"escape":     {"Escape", "Escape", 27, ""},
	"esc":        {"Escape", "Escape", 27, ""},
	"backspace":  {"Backspace", "Backspace", 8, ""},
	"delete":     {"Delete", "Delete", 46, ""},
	"space":      {" ", "Space", 32, " "},
	"home":       {"Home", "Home", 36, ""},
	"end":        {"End", "End", 35, ""},
	"pageup":     {"PageUp", "PageUp", 33, ""},
	"pagedown":   {"PageDown", "PageDown", 34, ""},
	"arrowup":    {"ArrowUp", "ArrowUp", 38, ""},
	"arrowdown":  {"ArrowDown", "ArrowDown", 40, ""},
	"arrowleft":  {"ArrowLeft", "ArrowLeft", 37, ""},
	"arrowright": {"ArrowRight", "ArrowRight", 39, ""},
	"up":         {"ArrowUp", "ArrowUp", 38, ""},
	"down":       {"ArrowDown", "ArrowDown", 40, ""},
	"left":       {"ArrowLeft", "ArrowLeft", 37, ""},
	"right":      {"ArrowRight", "ArrowRight", 39, ""},
}

func parseKeyChord(spec string) (keyChord, error) {
	parts := strings.Split(spec, "+")
	// "+" alone is the plus key; "ctrl++" means ctrl and the plus key.
	if spec == "+" {
		parts = []string{"+"}
	} else if strings.HasSuffix(spec, "++") {
		parts = append(strings.Split(strings.TrimSuffix(spec, "++"), "+"), "+")
	}
	chord := keyChord{}
	for _, mod := range parts[:len(parts)-1] {
		switch strings.ToLower(mod) {
		case "ctrl", "control":
			chord.modifiers |= modCtrl
		case "alt", "option":
			chord.modifiers |= modAlt
		case "shift":
			chord.modifiers |= modShift
		case "meta", "cmd", "command", "super":
			chord.modifiers |= modMeta
		default:
			return keyChord{}, fmt.Errorf("unknown modifier %q in %q", mod, spec)
		}
	}
	name := parts[len(parts)-1]
	if name == "" {
		return keyChord{}, fmt.Errorf("missing key in %q", spec)
	}
	if named, ok := namedKeys[strings.ToLower(name)]; ok {
		chord.key, chord.code, chord.keyCode, chord.text = named.key, named.code, named.keyCode, named.text
	} else if len(name) >= 2 && (name[0] == 'F' || name[0] == 'f') {
		n, err := strconv.Atoi(name[1:])
		if err != nil || n < 1 || n > 12 {
			return keyChord{}, fmt.Errorf("unknown key %q", name)
		}
		chord.key, chord.code, chord.keyCode = "F"+strconv.Itoa(n), "F"+strconv.Itoa(n), 111+n
	} else if len([]rune(name)) == 1 {
		r := []rune(name)[0]
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			upper := strings.ToUpper(string(r))
			chord.code, chord.keyCode = "Key"+upper, int(upper[0])
			chord.key = strings.ToLower(string(r))
			// A bare capital ("A") means shift+a, but in a shortcut such as
			// "Ctrl+H" the capital is only how the chord was written.
			shortcut := chord.modifiers&(modCtrl|modAlt|modMeta) != 0
			if r >= 'A' && r <= 'Z' && !shortcut {
				chord.modifiers |= modShift
			}
			if chord.modifiers&modShift != 0 {
				chord.key = upper
			}
		case r >= '0' && r <= '9':
			chord.code, chord.keyCode, chord.key = "Digit"+string(r), int(r), string(r)
		default:
			chord.key = string(r)
		}
		chord.text = chord.key
	} else {
		return keyChord{}, fmt.Errorf("unknown key %q", name)
	}
	// Chords with ctrl/alt/meta are shortcuts and type nothing.
	if chord.modifiers&(modCtrl|modAlt|modMeta) != 0 {
		chord.text = ""
	}
	return chord, nil
}

func (runner *actionRunner) runKeyAction(args []string) (map[string]any, int, error) {
	tabID, err := tabIDArgOrCurrent(args, runner.currentTabID)
	if err != nil {
		return nil, 0, err
	}
	keys := stringFlag(args, "--keys")
	if keys == "" {
		// Run plans: key ctrl+h, or key "Home shift+End".
		keys = strings.Join(positionalArgs(args), " ")
	}
	specs := strings.Fields(keys)
	if len(specs) == 0 {
		return nil, 0, errors.New("key requires --keys, e.g. --keys \"ctrl+h\" or --keys \"Home shift+End\"")
	}
	chords := make([]keyChord, 0, len(specs))
	for _, spec := range specs {
		chord, err := parseKeyChord(spec)
		if err != nil {
			return nil, 0, fmt.Errorf("key: %w", err)
		}
		chords = append(chords, chord)
	}
	if err := runner.attach(tabID); err != nil {
		return nil, 0, err
	}
	for _, chord := range chords {
		down := map[string]any{
			"type": "rawKeyDown", "key": chord.key, "code": chord.code, "modifiers": chord.modifiers,
			"windowsVirtualKeyCode": chord.keyCode, "nativeVirtualKeyCode": chord.keyCode,
		}
		if chord.text != "" {
			down["type"] = "keyDown"
			down["text"] = chord.text
			down["unmodifiedText"] = chord.text
		}
		if _, err := runner.cdpCall(tabID, "Input.dispatchKeyEvent", down); err != nil {
			return nil, 0, err
		}
		up := map[string]any{
			"type": "keyUp", "key": chord.key, "code": chord.code, "modifiers": chord.modifiers,
			"windowsVirtualKeyCode": chord.keyCode, "nativeVirtualKeyCode": chord.keyCode,
		}
		if _, err := runner.cdpCall(tabID, "Input.dispatchKeyEvent", up); err != nil {
			return nil, 0, err
		}
	}
	return map[string]any{"result": map[string]any{"pressed": specs}}, tabID, nil
}

// pasteScript fires a paste event carrying the text at the target element:
// the --selector match, else the focused element, following focus into
// same-origin iframes and open shadow roots (Google Docs keeps its editor in
// an iframe). Returns whether a page handler took the event.
const pasteScript = `((text, selector) => {
  let doc = document, el = null;
  if (selector) {
    el = document.querySelector(selector);
    if (!el) return { error: "no element matches " + JSON.stringify(selector) };
    el.focus?.();
    doc = el.ownerDocument;
  } else {
    el = document.activeElement;
    for (;;) {
      if (el?.shadowRoot?.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
        let inner = null;
        try { inner = el.contentDocument; } catch {}
        if (inner?.activeElement) { doc = inner; el = inner.activeElement; continue; }
      }
      break;
    }
  }
  if (!el || el === doc.body && !doc.body.isContentEditable && doc.designMode !== "on") {
    return { error: "nothing is focused to paste into; click the field first or pass --selector" };
  }
  const view = el.ownerDocument.defaultView || window;
  const data = new view.DataTransfer();
  data.setData("text/plain", text);
  const event = new view.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
  const snapshot = () => "value" in el ? String(el.value) : el.textContent;
  const before = snapshot();
  const notCancelled = el.dispatchEvent(event);
  // Some handlers insert the text without calling preventDefault; the content
  // changing counts as handled so the fallback doesn't insert it twice.
  const changed = snapshot() !== before;
  const root = el.getRootNode?.() || doc;
  const focused = root.activeElement === el || el.contains(doc.activeElement);
  const describe = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.isContentEditable ? "[contenteditable]" : "");
  return { handled: !notCancelled || changed, focused, target: describe };
})`

func (runner *actionRunner) runPasteAction(args []string) (map[string]any, int, error) {
	tabID, err := tabIDArgOrCurrent(args, runner.currentTabID)
	if err != nil {
		return nil, 0, err
	}
	text := stringFlag(args, "--text")
	if file := stringFlag(args, "--text-file"); file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, 0, fmt.Errorf("paste --text-file: %w", err)
		}
		text = string(raw)
	}
	if text == "" {
		return nil, 0, errors.New("paste requires --text or --text-file")
	}
	selector := stringFlag(args, "--selector")
	if err := runner.attach(tabID); err != nil {
		return nil, 0, err
	}
	encodedText, _ := json.Marshal(text)
	encodedSelector, _ := json.Marshal(selector)
	response, err := runner.cdpCall(tabID, "Runtime.evaluate", map[string]any{
		"expression":    pasteScript + "(" + string(encodedText) + "," + string(encodedSelector) + ")",
		"returnByValue": true,
	})
	if err != nil {
		return nil, 0, err
	}
	value := cdpResultValue(response)
	if value == nil {
		return nil, 0, fmt.Errorf("paste: could not read the page's reply: %v", response["result"])
	}
	if message, ok := value["error"].(string); ok {
		return nil, 0, fmt.Errorf("paste: %s", message)
	}
	result := map[string]any{"target": value["target"], "chars": len([]rune(text))}
	if handled, _ := value["handled"].(bool); handled {
		result["method"] = "paste-event"
		return map[string]any{"result": result}, tabID, nil
	}
	// No page handler took the paste (a plain input or textarea), so type it
	// into the focused element instead. Input.insertText goes to whatever has
	// focus, so refuse when the target could not take it.
	if focused, _ := value["focused"].(bool); !focused {
		return nil, 0, fmt.Errorf("paste: %s ignored the paste event and cannot take focus, so the text was not typed; pass a --selector for the editable element itself", value["target"])
	}
	if _, err := runner.cdpCall(tabID, "Input.insertText", map[string]any{"text": text}); err != nil {
		return nil, 0, err
	}
	result["method"] = "insertText"
	return map[string]any{"result": result}, tabID, nil
}

// Commands with a debugger-free equivalent in the extension. When another
// extension's frame blocks the debugger, attach errors for these are ignored
// and the extension runs the fallback.
func hasDebuggerFreeFallback(method string) bool {
	switch method {
	case "Runtime.evaluate", "Page.navigate", "Page.reload", "Page.captureScreenshot":
		return true
	}
	return false
}

func isForeignExtensionFrameError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "URL of different extension")
}

// attachFor attaches the debugger before method, tolerating a foreign-frame
// refusal when the extension can run method without it.
func (runner *actionRunner) attachFor(tabID int, method string) error {
	err := runner.attach(tabID)
	if isForeignExtensionFrameError(err) && hasDebuggerFreeFallback(method) {
		return nil
	}
	return err
}

func attachTabFor(options socketOptions, tabID int, method string) error {
	err := attachTab(options, tabID)
	if isForeignExtensionFrameError(err) && hasDebuggerFreeFallback(method) {
		return nil
	}
	return err
}
