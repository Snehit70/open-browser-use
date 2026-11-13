const REFRESH_INTERVAL_MS = 2000;
const WEBMCP_ENABLED_KEY = "OPEN_BROWSER_USE_WEBMCP_ENABLED";
const MAX_TABS_SHOWN = 4;

const chromeApi = globalThis.chrome;
const $ = (id) => document.getElementById(id);

let currentTab = null;
let lastRendered = "";

$("version").textContent = chromeApi?.runtime?.getManifest?.().version
  ? `v${chromeApi.runtime.getManifest().version}`
  : "";

$("reconnect").addEventListener("click", async () => {
  $("reconnect").disabled = true;
  await act({ action: "reconnect" });
  $("reconnect").disabled = false;
});

$("webmcp").addEventListener("change", (event) => {
  void chromeApi.storage.local.set({ [WEBMCP_ENABLED_KEY]: event.target.checked });
});

void init();

async function init() {
  [currentTab] = (await chromeApi.tabs.query({ active: true, currentWindow: true })) ?? [];
  await refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

async function refresh() {
  let state;
  try {
    state = await chromeApi.runtime.sendMessage({ type: "GET_POPUP_STATE" });
  } catch (error) {
    state = { ok: false, error: String(error?.message ?? error), sessions: [] };
  }
  if (currentTab?.id) {
    currentTab = (await chromeApi.tabs.get(currentTab.id).catch(() => null)) ?? currentTab;
  }
  // Skip identical re-renders so button feedback ("Copied") isn't wiped.
  const key = JSON.stringify([state, currentTab?.title, currentTab?.url, currentTab?.favIconUrl]);
  if (key === lastRendered) return;
  lastRendered = key;
  render(state);
}

async function act(message) {
  try {
    await chromeApi.runtime.sendMessage({ type: "POPUP_ACTION", ...message });
  } finally {
    lastRendered = "";
    await refresh();
  }
}

function render(state) {
  renderStatus(state?.status);
  $("webmcp").checked = state?.webMcpEnabled === true;
  renderCurrentTab(state?.sessions ?? []);
  renderTasks(state?.sessions ?? []);
}

function renderStatus(status) {
  const state = ["connected", "reconnecting", "disconnected"].includes(status?.state)
    ? status.state
    : "unknown";
  const labels = {
    connected: "Connected",
    reconnecting: "Reconnecting",
    disconnected: "Offline",
    unknown: "Unknown"
  };
  $("status").dataset.state = state;
  $("status-label").textContent = labels[state];

  const offline = state !== "connected";
  $("offline").hidden = !offline;
  if (offline) {
    $("offline-title").textContent =
      state === "reconnecting"
        ? `Reconnecting to the native host${status?.reconnectAttempt ? ` (attempt ${status.reconnectAttempt})` : ""}…`
        : "Agents can't reach this profile.";
    const error = typeof status?.error === "string" ? status.error.trim() : "";
    $("offline-error").hidden = !error;
    $("offline-error").textContent = error;
  }
}

function findSessionForTab(sessions, tabId) {
  for (const session of sessions) {
    const tab = session.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return { session, tab };
  }
  return null;
}

function renderCurrentTab(sessions) {
  const card = $("current-tab");
  if (!currentTab?.id) {
    card.replaceChildren(el("p", "muted", "No active tab."));
    return;
  }
  const internal = /^(chrome|edge|brave|about|chrome-extension|devtools):/i.test(currentTab.url ?? "");
  const owner = findSessionForTab(sessions, currentTab.id);

  let badge;
  if (internal) badge = el("span", "badge", "Not available");
  else if (owner?.tab.controlled) badge = el("span", "badge live", "Agent controlling");
  else if (owner) badge = el("span", "badge task", "In agent task");
  else badge = el("span", "badge", "Yours");

  const head = el("div", "tab-head");
  head.append(favicon(currentTab), tabText(currentTab), badge);

  const actions = el("div", "row");
  if (internal) {
    actions.append(el("span", "muted small", "Agents can't open browser pages like this one."));
  } else {
    const copy = button(`Copy tab ${currentTab.id} for agent`, "btn", async (btn) => {
      const text = `Use my browser tab ${currentTab.id}: "${currentTab.title ?? ""}" ${currentTab.url ?? ""}`.trim();
      await navigator.clipboard.writeText(text);
      flash(btn, "Copied");
    });
    copy.title = "Paste this into your agent chat so it claims this exact tab.";
    actions.append(copy);
    if (owner) {
      actions.append(
        button("Take back", "btn danger", () => act({ action: "releaseTab", tabId: currentTab.id }))
      );
    }
  }
  card.replaceChildren(head, actions);
}

function renderTasks(sessions) {
  const container = $("tasks");
  $("task-count").textContent = sessions.length ? String(sessions.length) : "";
  if (sessions.length === 0) {
    container.replaceChildren(
      el("p", "empty muted", "No agent tasks right now. When an agent starts, its tabs show up here and in a blue tab group.")
    );
    return;
  }
  container.replaceChildren(
    ...sessions.map((session) => {
      const card = el("div", "card task");
      const live = session.tabs.some((tab) => tab.controlled);

      const head = el("div", "task-head");
      const title = el("div", "task-title");
      title.append(
        el("span", `pulse${live ? " on" : ""}`),
        el("strong", "", session.title || "Agent task"),
        el("span", "muted small", `${session.tabs.length} tab${session.tabs.length === 1 ? "" : "s"}`)
      );
      head.append(
        title,
        button("End", "btn small danger", () => act({ action: "endSession", sessionId: session.sessionId }))
      );
      head.lastChild.title = "Stop the agent: detach it and ungroup these tabs. Tabs stay open.";

      const list = el("ul", "tabs");
      for (const tab of session.tabs.slice(0, MAX_TABS_SHOWN)) {
        const item = el("li");
        const link = el("button", "tab-link");
        link.type = "button";
        link.title = tab.url ?? "";
        link.append(favicon(tab), tabText(tab));
        if (tab.controlled) link.append(el("span", "badge live", "live"));
        link.addEventListener("click", () => focusTab(tab.id, session.windowId));
        item.append(link);
        list.append(item);
      }
      if (session.tabs.length > MAX_TABS_SHOWN) {
        list.append(el("li", "muted small more", `+${session.tabs.length - MAX_TABS_SHOWN} more`));
      }
      card.append(head, list);
      return card;
    })
  );
}

async function focusTab(tabId, windowId) {
  await chromeApi.tabs.update(tabId, { active: true }).catch(() => {});
  if (typeof windowId === "number") {
    await chromeApi.windows.update(windowId, { focused: true }).catch(() => {});
  }
}

function tabText(tab) {
  const wrap = el("span", "tab-text");
  wrap.append(el("span", "tab-title", tab.title || "Untitled"), el("span", "tab-host muted", hostOf(tab.url)));
  return wrap;
}

function favicon(tab) {
  const img = document.createElement("img");
  img.className = "favicon";
  img.alt = "";
  img.width = 16;
  img.height = 16;
  if (tab.favIconUrl && !tab.favIconUrl.startsWith("chrome://")) img.src = tab.favIconUrl;
  else img.classList.add("blank");
  img.addEventListener("error", () => {
    img.removeAttribute("src");
    img.classList.add("blank");
  });
  return img;
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol.replace(":", "");
  } catch {
    return "";
  }
}

function button(label, className, onClick) {
  const btn = el("button", className, label);
  btn.type = "button";
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

function flash(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
