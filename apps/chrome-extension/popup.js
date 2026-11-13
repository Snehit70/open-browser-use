const REFRESH_INTERVAL_MS = 1500;
const WEBMCP_ENABLED_KEY = "OPEN_BROWSER_USE_WEBMCP_ENABLED";
const MAX_TABS_SHOWN = 4;
const WORKING_WINDOW_MS = 8000;
const CONFIRM_WINDOW_MS = 2500;

const chromeApi = globalThis.chrome;
const $ = (id) => document.getElementById(id);

const ICONS = {
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><path d="M9 14h.01M15 14h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
};

// UI state that must survive the periodic re-render.
let currentTab = null;
let lastKey = "";
let copiedUntil = 0;
let armed = { id: null, until: 0 };

const version = chromeApi?.runtime?.getManifest?.().version;
$("version").textContent = version ? `v${version}` : "";

$("reconnect").addEventListener("click", () => act({ action: "reconnect" }));
$("status").addEventListener("click", () => act({ action: "reconnect" }));
$("webmcp").addEventListener("change", (event) => {
  void chromeApi.storage.local.set({ [WEBMCP_ENABLED_KEY]: event.target.checked });
});
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "c" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    document.querySelector("[data-copy]")?.click();
  }
});

void init();

async function init() {
  [currentTab] = (await chromeApi.tabs.query({ active: true, currentWindow: true })) ?? [];
  await refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

async function refresh(force = false) {
  let state;
  try {
    state = await chromeApi.runtime.sendMessage({ type: "GET_POPUP_STATE" });
  } catch (error) {
    state = { ok: false, status: { state: "disconnected", error: String(error?.message ?? error) } };
  }
  if (currentTab?.id) {
    currentTab = (await chromeApi.tabs.get(currentTab.id).catch(() => null)) ?? currentTab;
  }
  // Re-render only on change (keeps hover and transitions intact); the 10s
  // bucket refreshes relative times like "3m".
  const key = JSON.stringify([Math.floor(Date.now() / 10000), state, currentTab?.title, currentTab?.url, currentTab?.favIconUrl, copiedUntil > Date.now(), armed]);
  if (!force && key === lastKey) return;
  lastKey = key;
  render(state);
}

async function act(message) {
  try {
    await chromeApi.runtime.sendMessage({ type: "POPUP_ACTION", ...message });
  } finally {
    await refresh(true);
  }
}

function render(state) {
  const sessions = state?.sessions ?? [];
  renderStatus(state?.status);
  $("webmcp").checked = state?.webMcpEnabled === true;
  renderHere(sessions);
  renderTasks(sessions);
  renderResults(state?.results ?? []);
}

function renderStatus(status) {
  const value = ["connected", "reconnecting", "disconnected"].includes(status?.state) ? status.state : "unknown";
  const label = { connected: "Connected", reconnecting: "Reconnecting", disconnected: "Offline", unknown: "Unknown" }[value];
  const pill = $("status");
  pill.dataset.state = value;
  pill.disabled = value === "connected";
  pill.title = value === "connected" ? "Native host connected" : "Click to retry";
  $("status-label").textContent = label;

  const error = typeof status?.error === "string" ? status.error.trim() : "";
  $("offline").hidden = value === "connected";
  $("offline-title").textContent = value === "reconnecting" ? "Reconnecting…" : "Can't reach the CLI";
  $("offline-error").textContent = error || "Run open-browser-use setup";
  $("offline-error").title = error;
}

// ---------- This tab ----------

function renderHere(sessions) {
  const root = $("here");
  if (!currentTab?.id) {
    root.replaceChildren();
    return;
  }
  const internal = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i.test(currentTab.url ?? "");
  const owner = findOwner(sessions, currentTab.id);
  const mode = internal ? "locked" : owner?.tab.controlled ? "live" : owner ? "task" : "free";
  root.dataset.mode = mode;

  const text = el("div", "here-text");
  text.append(el("div", "title", currentTab.title || "Untitled"));
  const meta = el("div", "meta");
  meta.append(el("span", "", hostOf(currentTab.url) || "page"));
  if (!internal) meta.append(el("span", "mono", `#${currentTab.id}`));
  text.append(meta);

  const head = el("div", "here-head");
  head.append(favicon(currentTab, 20), text, chip(mode));

  const actions = el("div", "here-actions");
  if (internal) {
    actions.append(el("span", "hint", "Browser pages can't be shared"));
  } else {
    const copied = copiedUntil > Date.now();
    const copy = iconButton(copied ? "Copied" : "Copy for agent", ["copy", "check"], "btn primary grow", () => copyTab(copy));
    copy.dataset.copy = "";
    copy.classList.toggle("done", copied);
    copy.title = "Paste into your agent chat so it uses this exact tab (C)";
    copy.append(el("kbd", "", "C"));
    actions.append(copy);
    if (owner) {
      const take = iconButton("Take back", ["undo"], "btn", () => act({ action: "releaseTab", tabId: currentTab.id }));
      take.title = "Remove the agent from this tab";
      actions.append(take);
    }
  }
  root.replaceChildren(head, actions);
}

function chip(mode) {
  const labels = { live: "Agent driving", task: "In agent task", free: "Yours", locked: "Locked" };
  const node = el("span", `chip ${mode}`);
  if (mode === "live") node.append(el("span", "pulse"));
  if (mode === "locked") node.append(svg(ICONS.lock, 12));
  node.append(document.createTextNode(labels[mode]));
  return node;
}

async function copyTab(btn) {
  const title = (currentTab.title ?? "").replace(/\s+/g, " ").trim();
  const text = `Use my browser tab ${currentTab.id} ("${title}", ${currentTab.url})`;
  await navigator.clipboard.writeText(text);
  copiedUntil = Date.now() + 1500;
  btn.classList.add("done");
  btn.querySelector(".label").textContent = "Copied";
  setTimeout(() => refresh(true), 1600);
}

// ---------- Agent tasks ----------

function renderTasks(sessions) {
  $("task-count").textContent = sessions.length ? String(sessions.length) : "";
  const root = $("tasks");
  if (sessions.length === 0) {
    const empty = el("div", "empty");
    empty.append(svg(ICONS.bot, 18), el("span", "", "No agents running"));
    root.replaceChildren(empty);
    return;
  }
  const now = Date.now();
  root.replaceChildren(
    ...sessions.map((session) => {
      const working = session.tabs.some((tab) => tab.controlled) && now - (session.lastActivity ?? 0) < WORKING_WINDOW_MS;
      const card = el("article", `card task${working ? " working" : ""}`);

      const head = el("div", "task-head");
      const name = el("div", "task-name");
      name.append(el("span", "pulse"), el("span", "title", session.title || "Agent task"));
      const meta = el("span", "meta", taskMeta(session, working, now));
      const isArmed = armed.id === session.sessionId && armed.until > now;
      const end = iconButton(isArmed ? "End?" : "", ["stop"], `btn icon danger${isArmed ? " armed" : ""}`, () => {
        if (armed.id === session.sessionId && armed.until > Date.now()) {
          armed = { id: null, until: 0 };
          void act({ action: "endSession", sessionId: session.sessionId });
        } else {
          armed = { id: session.sessionId, until: Date.now() + CONFIRM_WINDOW_MS };
          void refresh(true);
          setTimeout(() => refresh(true), CONFIRM_WINDOW_MS + 50);
        }
      });
      end.title = isArmed ? "Click again to end. Tabs stay open." : "End task";
      end.setAttribute("aria-label", "End task");
      head.append(name, meta, end);

      const list = el("div", "list");
      for (const tab of session.tabs.slice(0, MAX_TABS_SHOWN)) {
        list.append(tabRow(tab, session.windowId, tab.controlled ? el("span", "pulse", "") : null));
      }
      if (session.tabs.length > MAX_TABS_SHOWN) {
        list.append(el("div", "more", `+${session.tabs.length - MAX_TABS_SHOWN} more`));
      }
      card.append(head, list);
      return card;
    })
  );
}

function taskMeta(session, working, now) {
  const tabs = `${session.tabs.length} tab${session.tabs.length === 1 ? "" : "s"}`;
  if (working) return `${tabs} · working`;
  const since = session.lastActivity ?? session.createdAt;
  return since ? `${tabs} · ${ago(now - since)}` : tabs;
}

// ---------- Results ----------

function renderResults(results) {
  $("results-section").hidden = results.length === 0;
  $("result-count").textContent = results.length ? String(results.length) : "";
  $("results").replaceChildren(...results.slice(0, MAX_TABS_SHOWN).map((tab) => tabRow(tab, tab.windowId)));
}

// ---------- Shared bits ----------

function tabRow(tab, windowId, trailing = null) {
  const row = el("button", "row");
  row.type = "button";
  row.title = tab.url ?? "";
  if (tab.id === currentTab?.id) row.classList.add("current");
  const text = el("span", "row-text");
  text.append(el("span", "title", tab.title || "Untitled"), el("span", "meta", hostOf(tab.url)));
  row.append(favicon(tab, 16), text);
  if (trailing) row.append(trailing);
  row.addEventListener("click", async () => {
    await chromeApi.tabs.update(tab.id, { active: true }).catch(() => {});
    if (typeof windowId === "number") await chromeApi.windows.update(windowId, { focused: true }).catch(() => {});
    window.close();
  });
  return row;
}

function findOwner(sessions, tabId) {
  for (const session of sessions) {
    const tab = session.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return { session, tab };
  }
  return null;
}

function iconButton(label, icons, className, onClick) {
  const btn = el("button", className);
  btn.type = "button";
  const wrap = el("span", "icons");
  icons.forEach((name, index) => wrap.append(svg(ICONS[name], 15, index === 0 ? "i-a" : "i-b")));
  btn.append(wrap);
  if (label) btn.append(el("span", "label", label));
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

function svg(paths, size, className = "") {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", size);
  node.setAttribute("height", size);
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  if (className) node.setAttribute("class", className);
  // Static, trusted markup from ICONS above.
  node.innerHTML = paths;
  return node;
}

function favicon(tab, size) {
  const blank = () => {
    const node = el("span", "favicon blank");
    node.style.width = node.style.height = `${size}px`;
    return node;
  };
  if (!tab.favIconUrl || !/^(https?|data):/.test(tab.favIconUrl)) return blank();
  const img = document.createElement("img");
  img.className = "favicon";
  img.alt = "";
  img.width = size;
  img.height = size;
  img.src = tab.favIconUrl;
  img.addEventListener("error", () => img.replaceWith(blank()));
  return img;
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.host.replace(/^www\./, "") || parsed.protocol.replace(":", "");
  } catch {
    return "";
  }
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
