# Open Browser Use Troubleshooting

Read this reference when setup, connection, browser control, file upload, download, or socket discovery fails.

## First Checks

Start with:

```sh
open-browser-use ping --session-id "$OBU_SESSION_ID"
open-browser-use info --session-id "$OBU_SESSION_ID"
open-browser-use user-tabs --session-id "$OBU_SESSION_ID"
```

For connection checks, set `OBU_SESSION_ID` to a temporary unique value first.
Do not reuse the CLI fallback session for agent browser work.

If these fail:

1. Confirm Chrome is installed.
2. Confirm Chrome is running.
3. Confirm the Open Browser Use extension is installed and enabled.
4. Confirm the native host manifest is installed with `open-browser-use install-manifest` or rerun `open-browser-use setup`.
5. Ask the user to approve any Chrome extension prompt.

Do not silently install, enable, or repair browser integration when the action needs user approval.

## Stale Socket Or Missing Active Host

The CLI first discovers the active socket from the registry. If the registry is
missing, recent CLI versions scan `--socket-dir` for `*.sock` files and connect
to the newest usable socket, then repair the registry. If the registry points to
a stale socket, the CLI removes the stale entry and stale socket file, then tries
the same socket-dir scan.

Useful flags:

```sh
open-browser-use ping --socket /tmp/open-browser-use/example.sock
open-browser-use ping --socket-dir /tmp/open-browser-use
open-browser-use ping --timeout 20s
```

If no active host exists, opening Chrome with the extension enabled can allow Chrome to start the native host.

## "No Chrome host was reachable" In The Middle Of A Task

Chrome stops an idle MV3 service worker, and the native host restarts with it.
For a moment no host answers. The CLI retries discovery, with or without
`--browser`/`--profile`, and the error then says how long it retried:

- A host socket exists but does not answer: up to 80% of `--timeout` (at most
  20 seconds).
- No host socket at all (browser closed, or mid-restart): about 4 seconds.
- Hosts answer but none matches `--browser`/`--profile` (a wrong selector, or
  that profile's host is restarting while another keeps running): about 4
  seconds; the error lists what is connected.

Time spent waiting mostly comes out of `--timeout`; the request itself always
keeps at least a quarter of it, so a command can run slightly past the limit. If it still fails, wait a few
seconds and run `ping` again. If the error says a host "accepted the
connection but did not answer", the extension is busy or restarting; retrying
usually works.

## Timeouts On Input Commands

A timeout means the CLI stopped waiting, not that Chrome skipped the command.
For clicks, key presses, typing, navigation, `Runtime.evaluate`, and other
commands with side effects, the error says the command may already have run.
Check the page (`page-info`, a screenshot) before retrying, or the action can
happen twice.

## Debugger Cannot Attach: Another Extension's Frame

The error "Cannot access a chrome-extension:// URL of different extension"
means another extension injected a frame into the page. Open Browser Use
retries three times over about five seconds, then names the frame it found.
For five seconds after that it fails fast instead of retrying again.

- `Runtime.evaluate`, `Page.navigate`, `Page.reload`, and
  `Page.captureScreenshot` (active tab only) fall back to running without the
  debugger and return `fallback: "no-debugger"`.
- Input events, `--frame` calls, and other CDP methods need the debugger. Ask
  the user to disable the named extension for this site, or reload the page
  after the frame goes away.
- If the tab itself shows another extension's page, nothing can attach;
  navigate it to a normal page or use another tab.

## Tab Errors

- "belongs to session S": another browser session owns the tab. Use
  `claim-tab --tab-id <id> --force` if that session was interrupted.
- "Chrome replaced it with tab N": use the new id from the message.
- "the tab no longer exists": the tab was closed. List tabs and open or claim
  another one.
- "...must come before the session's first tab": `open-tab --new-window` only
  works before the session has a tab group in the user's window. Start a new
  session id to get a separate window.
- "keeps its tabs in a separate window": a `--new-window` session cannot claim
  a tab from the user's window. Use another session id for that tab.

## Extension Or Native Host Mismatch

The native host manifest must allow the installed extension id. The default Web Store id is built into the CLI, while `setup beta` uses the keyed GitHub Release ZIP, registers that stable id, and reveals that same ZIP for manual installation.

For a ZIP that already exists locally, `setup --zip <path>` uses the same keyed
manual-install path without downloading the package. The supported `--zip`
input is a ZIP archive, not a CRX or certificate file.

Use:

```sh
open-browser-use manifest
open-browser-use install-manifest
open-browser-use setup
open-browser-use setup --zip /absolute/path/to/extension.zip
open-browser-use setup beta
```

If the user installed a custom extension build, pass the extension id explicitly:

```sh
open-browser-use install-manifest --extension-id <chrome-extension-id>
open-browser-use setup --extension-id <chrome-extension-id>
```

## File Upload Issues

Use the Open Browser Use file chooser flow rather than native OS picker automation where possible.

If Chrome blocks local file access for the extension, ask the user to open `chrome://extensions`, open Open Browser Use extension details, and enable file URL access if the task requires local file URLs.

## Permission And Safety Issues

- History, debugger, downloads, tab groups, and broad host access are high-privilege browser capabilities.
- Clipboard reads/writes should happen only for the user-requested task.
- If the user is on a login, payment, approval, CAPTCHA, or destructive workflow, pause and ask before continuing.

## When To Escalate To The User

Ask the user for help when:

- Chrome is not installed.
- Chrome is closed and opening it would interrupt their session.
- Chrome requires extension confirmation or enablement.
- The page requires login, CAPTCHA, hardware key, payment confirmation, or another human-only step.
- The requested browser action affects external systems.
