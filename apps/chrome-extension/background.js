const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";
const NATIVE_HOST_STATUS_KEY = "OPEN_BROWSER_USE_NATIVE_HOST_STATUS";
const SESSION_STATE_KEY = "OPEN_BROWSER_USE_SESSION_STATE";
const WEBMCP_ENABLED_KEY = "OPEN_BROWSER_USE_WEBMCP_ENABLED";
const RECONNECT_ALARM_NAME = "open-browser-use-native-reconnect";
const HEARTBEAT_ALARM_NAME = "open-browser-use-heartbeat";
const DEFAULT_CDP_TIMEOUT_MS = 10_000;
const DEFAULT_WEBMCP_TIMEOUT_MS = 10_000;
const DEFAULT_WEBMCP_LIST_TIMEOUT_MS = 5_000;
const WEBMCP_TIMEOUT_GRACE_MS = 1_500;
const CURSOR_ARRIVAL_TIMEOUT_MS = 1_000;
const MAX_USER_TABS = 1000;
const MAX_LOST_TABS = 200;
const DEFAULT_SESSION_GROUP_TITLE = "Task - OBU";
const DELIVERABLE_GROUP_TITLE = "✅ Open Browser Use";
const LEGACY_SESSION_GROUP_TITLE_PATTERN = /^Open Browser Use [0-9a-f]{8}$/i;
const WEBMCP_CAPABILITY = {
  id: "webmcp",
  description: "Fetch page-defined WebMCP tools bound to the current document and invoke them."
};
const WEBMCP_CONTENT_SCRIPTS = [
  {
    id: "open-browser-use-webmcp-main",
    js: ["content-webmcp-main.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: false,
    runAt: "document_start",
    world: "MAIN"
  },
  {
    id: "open-browser-use-webmcp-bridge",
    js: ["content-webmcp-bridge.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: false,
    runAt: "document_start",
    world: "ISOLATED"
  }
];

class JsonRpcPeer {
  constructor(transport, handlers) {
    this.transport = transport;
    this.handlers = handlers;
    this.transport.setMessageCallback((message) => {
      void this.handleMessage(message);
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      return;
    }
    const id = message.id;
    try {
      const handler = this.handlers[message.method];
      if (typeof handler !== "function") {
        throw new Error(`No handler registered for method: ${message.method}`);
      }
      const result = await handler.call(this.handlers, message.params ?? {});
      if (id !== undefined) {
        this.transport.sendMessage({ jsonrpc: "2.0", id, result: result ?? {} });
      }
    } catch (error) {
      if (id !== undefined) {
        this.transport.sendMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  sendNotification(method, params) {
    this.transport.sendMessage({ jsonrpc: "2.0", method, params });
  }
}

class NativeTransport {
  constructor(hostName) {
    this.hostName = hostName;
    this.port = null;
    this.messageCallback = null;
    this.reconnectAttempt = 0;
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      state: "disconnected"
    };
    this.connect();
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === RECONNECT_ALARM_NAME && !this.port) {
        this.connect();
      }
    });
  }

  setMessageCallback(callback) {
    this.messageCallback = callback;
  }

  sendMessage(message) {
    if (!this.port) {
      this.scheduleReconnect("native host disconnected");
      throw new Error("Native host is disconnected");
    }
    this.port.postMessage(message);
  }

  connect() {
    if (this.port) {
      return;
    }
    try {
      const port = chrome.runtime.connectNative(this.hostName);
      this.port = port;
      this.reconnectAttempt = 0;
      this.setStatus({ state: "connected" });
      port.onMessage.addListener((message) => {
        this.messageCallback?.(message);
      });
      port.onDisconnect.addListener(() => {
        this.port = null;
        this.scheduleReconnect(chrome.runtime.lastError?.message ?? "native host disconnected");
      });
    } catch (error) {
      this.port = null;
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  scheduleReconnect(error) {
    this.reconnectAttempt += 1;
    this.setStatus({
      state: "reconnecting",
      error,
      nextRetryMs: 5000,
      reconnectAttempt: this.reconnectAttempt
    });
    chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: 0.1 }).catch(() => {});
  }

  setStatus(status) {
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      ...status
    };
    chrome.storage.local
      .set({
        [NATIVE_HOST_STATUS_KEY]: this.status
      })
      .catch(() => {});
  }

  getStatus() {
    return this.status;
  }
}

class SessionStore {
  constructor() {
    this.state = { sessions: {}, deliverableGroupId: null };
    this.ready = this.load();
  }

  async load() {
    const stored = await chrome.storage.local.get(SESSION_STATE_KEY);
    const value = stored[SESSION_STATE_KEY];
    if (value && typeof value === "object") {
      this.state = {
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
        deliverableGroupId:
          typeof value.deliverableGroupId === "number" ? value.deliverableGroupId : null
      };
      let migrated = false;
      for (const session of Object.values(this.state.sessions)) {
        if (
          session &&
          typeof session === "object" &&
          typeof session.title === "string" &&
          LEGACY_SESSION_GROUP_TITLE_PATTERN.test(session.title)
        ) {
          session.title = DEFAULT_SESSION_GROUP_TITLE;
          migrated = true;
        }
      }
      if (migrated) {
        await this.save();
      }
      if (typeof this.state.deliverableGroupId === "number") {
        await chrome.tabGroups
          .update(this.state.deliverableGroupId, { title: DELIVERABLE_GROUP_TITLE })
          .catch(() => {});
      }
    }
  }

  async save() {
    await chrome.storage.local.set({ [SESSION_STATE_KEY]: this.state });
  }

  async getSession(sessionId) {
    await this.ready;
    const existing = this.state.sessions[sessionId];
    if (existing && typeof existing === "object") {
      return existing;
    }
    const created = {
      chromeGroupId: null,
      title: DEFAULT_SESSION_GROUP_TITLE,
      activeTabId: null,
      tabOrigins: {},
      createdAt: Date.now()
    };
    this.state.sessions[sessionId] = created;
    await this.save();
    return created;
  }

  async removeSession(sessionId) {
    await this.ready;
    delete this.state.sessions[sessionId];
    await this.save();
  }

  async findSessionByGroup(groupId) {
    await this.ready;
    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      if (session.chromeGroupId === groupId) {
        return { sessionId, session };
      }
    }
    return null;
  }
}

class WebMcpGate {
  constructor() {
    this.enabledValue = false;
    this.applyQueue = Promise.resolve(false);
    this.ready = this.refresh();
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local" || !Object.hasOwn(changes, WEBMCP_ENABLED_KEY)) {
        return;
      }
      const enabled = changes[WEBMCP_ENABLED_KEY]?.newValue !== false;
      this.ready = this.queueApply(enabled);
    });
  }

  async enabled() {
    await this.ready;
    return this.enabledValue;
  }

  async refresh() {
    try {
      const stored = await chrome.storage.local.get(WEBMCP_ENABLED_KEY);
      return await this.queueApply(stored[WEBMCP_ENABLED_KEY] !== false);
    } catch {
      this.enabledValue = false;
      return false;
    }
  }

  queueApply(enabled) {
    this.applyQueue = this.applyQueue
      .catch(() => false)
      .then(async () => await this.apply(enabled));
    return this.applyQueue;
  }

  async apply(enabled) {
    if (
      typeof chrome.scripting?.getRegisteredContentScripts !== "function" ||
      typeof chrome.scripting?.registerContentScripts !== "function" ||
      typeof chrome.scripting?.unregisterContentScripts !== "function"
    ) {
      this.enabledValue = false;
      return false;
    }
    const ids = WEBMCP_CONTENT_SCRIPTS.map((script) => script.id);
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: registered.map((script) => script.id) });
    }
    if (enabled) {
      await chrome.scripting.registerContentScripts(WEBMCP_CONTENT_SCRIPTS);
    }
    this.enabledValue = enabled;
    return enabled;
  }
}

class BrowserBackend {
  constructor({ webMcpGate = null } = {}) {
    this.store = new SessionStore();
    this.webMcpGate = webMcpGate;
    this.attachedTabs = new Set();
    this.activeTabsBySession = new Map();
    this.lastActivityBySession = new Map();
    this.cursorByTabId = new Map();
    this.downloadFilenamesById = new Map();
    this.downloadUrlsById = new Map();
    this.downloadsById = new Map();
    this.downloadWaiters = new Set();
    this.downloadChangeListeners = new Set();
    this.cursorArrivalWaitersByKey = new Map();
    this.fileChoosersById = new Map();
    this.fileChooserWaitersByTabId = new Map();
    this.dialogsByTabId = new Map();
    // tabId -> Map(sessionId -> child target) for out-of-process iframes,
    // which Runtime.evaluate on the tab cannot see.
    this.framesByTabId = new Map();
    this.pendingSpawns = new Map();
    this.attachSetups = new Map();
    // Tabs where this extension turned Emulation.setFocusEmulationEnabled on,
    // so page-info and scroll can say what the page's visibilityState means.
    this.focusEmulatedTabs = new Set();
    // tabId -> { reason, sessionId, at, replacedBy? } for session tabs that
    // were closed or replaced, so a later "not part of session" error can say
    // what happened instead of leaving the agent guessing.
    this.lostTabs = new Map();
    // tabId -> { at, frames } for tabs whose debugger attach was refused
    // because another extension's frame is in the page.
    this.foreignAttachFailures = new Map();
    this.nextCursorMoveSequence = 1;
    chrome.debugger.onDetach.addListener((source) => {
      if (typeof source.tabId === "number") {
        this.attachedTabs.delete(source.tabId);
        this.dialogsByTabId.delete(source.tabId);
        this.framesByTabId.delete(source.tabId);
        this.focusEmulatedTabs.delete(source.tabId);
      }
    });
    chrome.tabs?.onRemoved?.addListener((tabId) => {
      this.forgetTab(tabId, { reason: "closed" }).catch(() => {});
    });
    // Prerendering and some redirects swap the tab for a new one with a new id.
    chrome.tabs?.onReplaced?.addListener((addedTabId, removedTabId) => {
      this.replaceTab(addedTabId, removedTabId).catch(() => {});
    });
    // Links with target=_blank and window.open() in a session tab land in the
    // session group with no recorded origin, so finalize would only ungroup
    // them and leave them open. Record them as agent tabs.
    chrome.tabs?.onCreated?.addListener((tab) => {
      const pending = this.recordSpawnedTab(tab).catch(() => {});
      if (hasTabId(tab)) {
        // ensureAttached waits on this so a spawned tab is known to be an
        // agent tab before deciding on focus emulation.
        this.pendingSpawns.set(tab.id, pending);
        pending.finally(() => this.pendingSpawns.delete(tab.id));
      }
    });
  }

  async recordSpawnedTab(tab) {
    if (!hasTabId(tab) || typeof tab.openerTabId !== "number") {
      return;
    }
    await this.store.ready;
    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
    if (!opener || typeof opener.groupId !== "number" || opener.groupId === -1) {
      return;
    }
    const owner = await this.store.findSessionByGroup(opener.groupId);
    if (!owner || !owner.session.tabOrigins?.[String(opener.id)]) {
      return;
    }
    owner.session.tabOrigins[String(tab.id)] ??= "agent";
    await this.store.save();
    // Chrome only puts a spawned tab in the opener's group when it opens next
    // to it. A tab opened at the end of the strip or in another window stays
    // ungrouped, and the session would never see it. Pull it in.
    if (tab.groupId !== opener.groupId) {
      await chrome.tabs.group({ groupId: opener.groupId, tabIds: [tab.id] }).catch(() => {});
    }
  }

  // A session tab closed: drop it from its session and remember why, for
  // requireSessionTab's error.
  async forgetTab(tabId, { reason, replacedBy } = {}) {
    await this.store.ready;
    this.attachedTabs.delete(tabId);
    this.focusEmulatedTabs.delete(tabId);
    this.foreignAttachFailures.delete(tabId);
    for (const [sessionId, session] of Object.entries(this.store.state.sessions ?? {})) {
      const key = String(tabId);
      if (!session.tabOrigins || !(key in session.tabOrigins)) continue;
      this.rememberLostTab(tabId, { reason, sessionId, replacedBy });
      if (replacedBy === undefined) {
        delete session.tabOrigins[key];
        await this.store.save();
      }
    }
  }

  rememberLostTab(tabId, entry) {
    this.lostTabs.set(tabId, { ...entry, at: Date.now() });
    while (this.lostTabs.size > MAX_LOST_TABS) {
      this.lostTabs.delete(this.lostTabs.keys().next().value);
    }
  }

  // Keep a replaced tab in its session under the new id.
  async replaceTab(addedTabId, removedTabId) {
    await this.store.ready;
    const removedKey = String(removedTabId);
    for (const [sessionId, session] of Object.entries(this.store.state.sessions ?? {})) {
      const origin = session.tabOrigins?.[removedKey];
      if (!origin) continue;
      delete session.tabOrigins[removedKey];
      session.tabOrigins[String(addedTabId)] = origin;
      if (session.activeTabId === removedTabId) session.activeTabId = addedTabId;
      if (this.activeTabsBySession.get(sessionId) === removedTabId) {
        this.activeTabsBySession.set(sessionId, addedTabId);
      }
      this.rememberLostTab(removedTabId, { reason: "replaced", sessionId, replacedBy: addedTabId });
      await this.store.save();
      if (typeof session.chromeGroupId === "number") {
        await chrome.tabs.group({ groupId: session.chromeGroupId, tabIds: [addedTabId] }).catch(() => {});
      }
    }
    this.attachedTabs.delete(removedTabId);
    this.focusEmulatedTabs.delete(removedTabId);
  }

  ping() {
    return "pong";
  }

  async getInfo() {
    let { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
    if (typeof extensionInstanceId !== "string") {
      extensionInstanceId = crypto.randomUUID();
      await chrome.storage.local.set({ extensionInstanceId });
    }
    const webMcpEnabled = (await this.webMcpGate?.enabled?.()) === true;
    return {
      name: "Open Browser Use Chrome",
      version: chrome.runtime.getManifest().version,
      type: "extension",
      capabilities: {
        tab: webMcpEnabled ? [WEBMCP_CAPABILITY] : []
      },
      metadata: {
        extensionId: chrome.runtime.id,
        extensionInstanceId,
        nativeHostName: NATIVE_HOST_NAME
      }
    };
  }

  async createTab(params) {
    const session = await this.requireSession(params);
    const sessionState = await this.store.getSession(session.sessionId);
    // newWindow keeps the session's tabs in their own unfocused window, so
    // screenshots (which must make the tab active to paint it) never swap out
    // the tab the user is looking at. Later tabs in the session follow it.
    const wantsWindow = params.newWindow === true || typeof sessionState.agentWindowId === "number";
    const chromeTab = wantsWindow
      ? await this.createAgentWindowTab(sessionState)
      : await createBackgroundTab();
    await this.ensureSessionGroup(session.sessionId, chromeTab.id, "agent");
    await this.setSessionActiveTab(session.sessionId, chromeTab.id);
    return { ...toBrowserTab(chromeTab), active: true };
  }

  async createAgentWindowTab(sessionState) {
    if (typeof sessionState.agentWindowId === "number") {
      const win = await chrome.windows.get(sessionState.agentWindowId).catch(() => null);
      if (win) {
        const tab = await chrome.tabs.create({ active: true, url: "about:blank", windowId: win.id }).catch(() => null);
        if (hasTabId(tab)) return tab;
      }
    } else if (typeof sessionState.chromeGroupId === "number") {
      // Groups cannot span windows, and adding a tab to the session's group
      // would pull it back into the user's window.
      const group = await chrome.tabGroups.get(sessionState.chromeGroupId).catch(() => null);
      if (group) {
        throw new Error(
          "open-tab --new-window must come before the session's first tab; this session already has tabs in another window. Use a new --session-id."
        );
      }
    }
    const win = await chrome.windows.create({ focused: false, type: "normal", url: "about:blank" });
    const tab = win.tabs?.find(hasTabId);
    if (!tab) {
      throw new Error("Created Chrome window has no tab");
    }
    sessionState.agentWindowId = win.id;
    sessionState.chromeGroupId = null;
    await this.store.save();
    return tab;
  }

  async getTabs(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    const origins = (await this.store.getSession(session.sessionId)).tabOrigins ?? {};
    return await this.withLogicalActive(
      session.sessionId,
      tabs.map((tab) => ({ ...toBrowserTab(tab), origin: origins[String(tab.id)] ?? null }))
    );
  }

  async getUserTabs(params) {
    await this.requireSession(params);
    const tabs = (await chrome.tabs.query({}))
      .filter(hasTabId)
      .sort(compareLastAccessed)
      .slice(0, MAX_USER_TABS);
    const groupTitles = await readGroupTitles(tabs);
    // Name the session that owns a grouped tab, so an agent whose earlier
    // session was interrupted can see which tab is still claimed and by whom.
    const groupSessions = new Map();
    for (const [sessionId, session] of Object.entries(this.store.state.sessions ?? {})) {
      if (typeof session.chromeGroupId === "number") groupSessions.set(session.chromeGroupId, sessionId);
    }
    return tabs.map((tab) => {
      const userTab = toUserTab(tab, groupTitles);
      const owner = groupSessions.get(tab.groupId);
      return owner ? { ...userTab, sessionId: owner } : userTab;
    });
  }

  /**
   * Search retained history for one or more terms.
   * Merges matches by URL (newest visit wins) and applies a single limit.
   */
  async getUserHistory(params) {
    await this.requireSession(params);
    if (params.queries == null && params.query != null && typeof params.query !== "string") {
      throw new Error("getUserHistory requires query to be a string");
    }
    const queries = params.queries ?? [params.query ?? ""];
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new Error("getUserHistory requires queries to be a non-empty array of strings");
    }
    for (const query of queries) {
      if (typeof query !== "string") {
        throw new Error("getUserHistory requires queries to be a non-empty array of strings");
      }
    }
    const maxResults = optionalPositiveInteger(params.limit ?? undefined, 100, "getUserHistory limit");
    // Chrome searches only the last 24 hours when startTime is omitted.
    const search = { maxResults, startTime: 0 };
    for (const [field, key] of [["from", "startTime"], ["to", "endTime"]]) {
      if (params[field] == null) continue;
      if (typeof params[field] !== "string") {
        throw new Error(`getUserHistory requires ${field} to be a valid date`);
      }
      search[key] = parseDate(params[field], field);
    }
    if (search.endTime !== undefined && search.endTime < search.startTime) {
      throw new Error("getUserHistory requires to >= from");
    }
    const batches = await Promise.all(
      [...new Set(queries)].map((text) => chrome.history.search({ ...search, text }))
    );
    const seenUrls = new Set();
    return batches
      .flat()
      .filter((item) =>
        typeof item?.url === "string" &&
        typeof item.lastVisitTime === "number" &&
        Number.isFinite(new Date(item.lastVisitTime).getTime())
      )
      .sort((left, right) => right.lastVisitTime - left.lastVisitTime)
      .filter(({ url }) => {
        if (seenUrls.has(url)) return false;
        seenUrls.add(url);
        return true;
      })
      .slice(0, maxResults)
      .map((item) => ({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        dateVisited: new Date(item.lastVisitTime).toISOString()
      }));
  }

  async claimUserTab(params) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "claimUserTab");
    const tab = await chrome.tabs.get(tabId);
    if (!hasTabId(tab)) {
      throw new Error(`Chrome tab ${tabId} has no id`);
    }
    if (tab.url?.startsWith("chrome://")) {
      throw new Error(
        `Tab ${tabId} shows ${tab.url}; Chrome does not let extensions control chrome:// pages. Open the page in a new tab with open-tab --url if it has a web equivalent.`
      );
    }
    let origin = "user";
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      if (owner && owner.sessionId !== session.sessionId) {
        if (params.force !== true) {
          throw new Error(
            `Tab ${tabId} is already part of browser session ${owner.sessionId}. ` +
              `If that session was interrupted, take the tab over with: obu claim-tab --tab-id ${tabId} --force, ` +
              `or keep working in it with --session-id ${owner.sessionId}.`
          );
        }
        // Take over: keep the origin so finalize still closes a tab the agent
        // opened and only ungroups one the user opened.
        const key = String(tab.id);
        origin = owner.session.tabOrigins?.[key] ?? "user";
        delete owner.session.tabOrigins?.[key];
        if (owner.session.activeTabId === tab.id) owner.session.activeTabId = null;
        if (this.activeTabsBySession.get(owner.sessionId) === tab.id) {
          this.activeTabsBySession.delete(owner.sessionId);
        }
        await this.store.save();
        await chrome.tabs.ungroup(tab.id).catch(() => {});
      } else if (owner) {
        origin = owner.session.tabOrigins?.[String(tab.id)] ?? "user";
      }
    }
    // Forget any earlier attachment record so the next command re-attaches
    // against the tab's current state instead of trusting a stale entry.
    this.attachedTabs.delete(tab.id);
    this.focusEmulatedTabs.delete(tab.id);
    this.lostTabs.delete(tab.id);
    await this.ensureSessionGroup(session.sessionId, tab.id, origin);
    await this.setSessionActiveTab(session.sessionId, tab.id);
    return { ...toBrowserTab(tab), active: true };
  }

  async finalizeTabs(params) {
    const session = await this.requireSession(params);
    if (!Array.isArray(params.keep)) {
      throw new Error("finalizeTabs requires keep array");
    }
    // Include chrome:// tabs: an agent tab navigated to one is still the
    // session's to close, and leaving it would strand it in the group.
    const tabs = await this.getSessionTabs(session.sessionId, { includeInternal: true });
    const knownTabIds = new Set(tabs.filter(hasTabId).map((tab) => tab.id));
    const keep = new Map();
    for (const entry of params.keep) {
      if (!entry || typeof entry !== "object") {
        throw new Error("finalizeTabs received invalid tab entry");
      }
      const tabId = requireTabId(entry, "finalizeTabs");
      if (!knownTabIds.has(tabId)) {
        throw new Error(`finalizeTabs cannot keep unknown tab ${tabId}`);
      }
      if (keep.has(tabId)) {
        throw new Error(`finalizeTabs received duplicate tab ${tabId}`);
      }
      const status = entry.status;
      if (status !== "handoff" && status !== "deliverable") {
        throw new Error(`finalizeTabs received invalid status ${String(status)}`);
      }
      keep.set(tabId, status);
    }
    const sessionState = await this.store.getSession(session.sessionId);
    const agentTabsToClose = [];
    const userTabsToRelease = [];
    const deliverableTabs = [];
    const handoffTabs = [];
    for (const tab of tabs) {
      if (!hasTabId(tab)) {
        continue;
      }
      const keptStatus = keep.get(tab.id);
      if (keptStatus === "handoff") {
        handoffTabs.push(tab.id);
        continue;
      }
      if (keptStatus === "deliverable") {
        deliverableTabs.push(tab.id);
        continue;
      }
      if (sessionState.tabOrigins[String(tab.id)] === "agent") {
        agentTabsToClose.push(tab.id);
      } else {
        userTabsToRelease.push(tab.id);
      }
    }
    // Detach every disposition, including handoff tabs we keep alive: leaving a
    // tab attached keeps Chrome's "started debugging this browser" banner up
    // after the turn ends. The debugger re-attaches lazily on the next CDP call
    // (the CLI runner and background handlers attach on demand), so dropping it
    // here is loss-free while clearing the banner.
    await this.detachMany([
      ...agentTabsToClose,
      ...userTabsToRelease,
      ...deliverableTabs,
      ...handoffTabs
    ]);
    if (agentTabsToClose.length > 0) {
      await chrome.tabs.remove(agentTabsToClose.length === 1 ? agentTabsToClose[0] : agentTabsToClose);
    }
    if (userTabsToRelease.length > 0 && chrome.tabs.ungroup) {
      await chrome.tabs.ungroup(userTabsToRelease.length === 1 ? userTabsToRelease[0] : userTabsToRelease);
    }
    if (deliverableTabs.length > 0) {
      await this.moveToDeliverables(deliverableTabs);
    }
    for (const tabId of [...agentTabsToClose, ...userTabsToRelease, ...deliverableTabs]) {
      delete sessionState.tabOrigins[String(tabId)];
      this.cursorByTabId.delete(tabId);
    }
    if (handoffTabs.length > 0) {
      sessionState.activeTabId = handoffTabs.includes(sessionState.activeTabId)
        ? sessionState.activeTabId
        : handoffTabs[0];
      this.activeTabsBySession.set(session.sessionId, sessionState.activeTabId);
      await this.store.save();
    } else {
      this.activeTabsBySession.delete(session.sessionId);
      await this.store.removeSession(session.sessionId);
    }
  }

  async nameSession(params) {
    const session = await this.requireSession(params);
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : DEFAULT_SESSION_GROUP_TITLE;
    const sessionState = await this.store.getSession(session.sessionId);
    sessionState.title = name;
    await this.store.save();
    if (typeof sessionState.chromeGroupId === "number") {
      await chrome.tabGroups.update(sessionState.chromeGroupId, { title: name }).catch(() => {});
    }
  }

  async attach(params) {
    await this.requireSessionTab(params, "attach");
    const tabId = requireTabId(params, "attach");
    await this.ensureAttached(tabId);
  }

  // Attach the debugger unless this tab is already tracked as attached. Chrome
  // drops the attachment on some navigations and reloads, and the service worker
  // forgets attachedTabs when it restarts, so callers re-check right before each
  // command instead of trusting state from an earlier call.
  async ensureAttached(tabId) {
    if (this.attachedTabs.has(tabId)) {
      // Another caller may still be setting the tab up; run after it.
      await this.attachSetups.get(tabId);
      return;
    }
    await this.attachDebugger(tabId);
    this.attachedTabs.add(tabId);
    const setup = this.setUpAttachedTab(tabId);
    this.attachSetups.set(tabId, setup);
    try {
      await setup;
    } finally {
      if (this.attachSetups.get(tabId) === setup) this.attachSetups.delete(tabId);
    }
  }

  async attachDebugger(tabId) {
    // A frame from another extension (a password manager, an OAuth helper)
    // makes Chrome refuse the attach. Such frames are usually short-lived, so
    // retry with backoff, but only once per few seconds per tab: if the last
    // attempt just failed, fail fast instead of stalling every command.
    const recent = this.foreignAttachFailures.get(tabId);
    const delays = recent && Date.now() - recent.at < FOREIGN_ATTACH_COOLDOWN_MS ? [] : FOREIGN_ATTACH_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        this.foreignAttachFailures.delete(tabId);
        return;
      } catch (error) {
        const message = String(error?.message ?? error);
        // Our own attachment can outlive a service worker restart; Chrome then
        // reports it as "Another debugger". A real foreign debugger surfaces on
        // the next sendCommand instead.
        if (message.includes("Another debugger")) {
          this.foreignAttachFailures.delete(tabId);
          return;
        }
        if (!isForeignExtensionFrameError(error)) {
          throw error;
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const tabUrl = tab?.url || tab?.pendingUrl || "";
        if (tabUrl.startsWith("chrome-extension://")) {
          // The tab itself navigated to another extension's page; waiting
          // will not help.
          throw new Error(
            `${message} (tab ${tabId}). The tab now shows another extension's page (${tabUrl.split("/").slice(0, 3).join("/")}), which no other extension may debug. Navigate it back with obu navigate, or use another tab.`
          );
        }
        if (attempt >= delays.length) {
          const frames = await findExtensionFrames(tabId);
          this.foreignAttachFailures.set(tabId, { at: Date.now(), frames });
          throw new Error(foreignFrameMessage(tabId, message, frames));
        }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  // Turn focus emulation on or off and remember it, so commands can report
  // what the page's visibilityState and hasFocus() mean.
  async setFocusEmulation(tabId, enabled) {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled });
    if (enabled) {
      this.focusEmulatedTabs.add(tabId);
    } else {
      this.focusEmulatedTabs.delete(tabId);
    }
  }

  // The tab's real state, independent of what the page sees. Focus emulation
  // only changes what the page reports (and not always: Chromium forks differ),
  // so agents should read active/windowFocused to know whether the user can
  // see the tab.
  async getTabState(params) {
    await this.requireSessionTab(params, "getTabState");
    const tabId = requireTabId(params, "getTabState");
    const tab = await chrome.tabs.get(tabId);
    const win = typeof tab.windowId === "number" ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
    return {
      tabId,
      active: tab.active === true,
      windowId: tab.windowId ?? null,
      windowFocused: win?.focused === true,
      windowState: win?.state ?? null,
      visibleToUser: tab.active === true && win?.state !== "minimized",
      focusEmulated: this.focusEmulatedTabs.has(tabId),
      agentTab: this.isAgentTab(tabId),
      debuggerAttached: this.attachedTabs.has(tabId),
      ...(this.foreignAttachFailures.has(tabId)
        ? { attachBlockedBy: this.foreignAttachFailures.get(tabId).frames }
        : {})
    };
  }

  async setUpAttachedTab(tabId) {
    await this.pendingSpawns.get(tabId);
    // Page events are off until Page.enable; without them a JavaScript dialog
    // is invisible and every later command just times out.
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {}).catch(() => {});
    // Agent tabs are usually in the background, where pages see
    // visibilityState "hidden" and lazy loaders and infinite scroll stall.
    // Focus emulation makes the page behave as if it were the focused tab.
    // Only for tabs the agent opened: on a tab claimed from the user it would
    // also mark chats read or keep media playing while the user is elsewhere.
    if (this.isAgentTab(tabId)) {
      await this.setFocusEmulation(tabId, true).catch(() => {});
    } else {
      this.focusEmulatedTabs.delete(tabId);
    }
    await this.enableFrameAttach({ tabId });
  }

  isAgentTab(tabId) {
    const sessions = Object.values(this.store.state.sessions ?? {});
    return sessions.some((session) => session.tabOrigins?.[String(tabId)] === "agent");
  }

  // Cross-site iframes run in their own renderer. Auto-attach (flatten) gives
  // each one a child session that commands can target with {tabId, sessionId}.
  async enableFrameAttach(target) {
    await chrome.debugger
      .sendCommand(target, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      })
      .catch(() => {});
  }

  frameList(tabId) {
    return [...(this.framesByTabId.get(tabId)?.values() ?? [])].filter((frame) => frame.type === "iframe");
  }

  async listFrames(params) {
    await this.requireSessionTab(params, "listFrames");
    const tabId = requireTabId(params, "listFrames");
    await this.ensureAttached(tabId);
    if (this.frameList(tabId).length === 0) {
      await this.resyncFrames(tabId);
    }
    const tab = await chrome.tabs.get(tabId);
    return {
      frames: [
        { sessionId: null, type: "page", url: tab.url ?? "", title: tab.title ?? "" },
        ...this.frameList(tabId).map(({ sessionId, url, title, parentSessionId }) => ({
          sessionId,
          type: "iframe",
          url,
          title,
          ...(parentSessionId ? { parentSessionId } : {})
        }))
      ]
    };
  }

  // A service worker restart forgets child sessions while Chrome keeps them;
  // toggling auto-attach makes Chrome announce them again.
  async resyncFrames(tabId) {
    await chrome.debugger
      .sendCommand({ tabId }, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
      .catch(() => {});
    await this.enableFrameAttach({ tabId });
    await new Promise((resolve) => setTimeout(resolve, FRAME_ATTACH_SETTLE_MS));
  }

  // Resolve --frame: an exact child sessionId or targetId, else the first
  // iframe whose URL contains the text. Waits briefly for iframes that are
  // still loading or re-attaching.
  async resolveFrame(tabId, match) {
    const find = () =>
      this.frameList(tabId).find((frame) => frame.sessionId === match || frame.targetId === match) ??
      this.frameList(tabId).find((frame) => frame.url.includes(match));
    const deadline = Date.now() + FRAME_RESOLVE_WAIT_MS;
    let resynced = false;
    while (true) {
      const frame = find();
      if (frame) {
        return frame;
      }
      if (!resynced && this.frameList(tabId).length === 0) {
        resynced = true;
        await this.resyncFrames(tabId);
        continue;
      }
      if (Date.now() >= deadline) {
        const known = this.frameList(tabId).map((frame) => frame.url);
        throw new Error(
          `No cross-origin iframe in tab ${tabId} matches "${match}". ` +
            (known.length > 0
              ? `Iframes: ${known.join(", ")}.`
              : "The tab has none; same-origin iframes are reachable from the page through iframe.contentDocument.")
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async detach(params) {
    await this.requireSessionTab(params, "detach");
    const tabId = requireTabId(params, "detach");
    await this.detachTab(tabId);
  }

  async executeCdp(params) {
    await this.requireSession(params);
    const rawTarget = params.target && typeof params.target === "object" ? params.target : {};
    const tabId = rawTarget.tabId;
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    if (typeof tabId === "number") {
      await this.requireSessionTab({ ...params, tabId }, "executeCdp");
      try {
        await this.ensureAttached(tabId);
      } catch (error) {
        // Another extension's frame blocks the debugger. A few commands have
        // debugger-free equivalents; run those so the agent is not blind.
        if (isForeignExtensionFrameError(error) && DEBUGGER_FREE_METHODS.has(params.method) && !rawTarget.frame) {
          return await withTimeout(timeoutMs, () =>
            this.executeWithoutDebugger(tabId, params.method, params.commandParams ?? {}, error)
          );
        }
        throw error;
      }
    }
    if (typeof tabId === "number" && params.method !== "Page.handleJavaScriptDialog") {
      const dialog = this.dialogsByTabId.get(tabId);
      if (dialog) {
        throw new Error(dialogBlockedMessage(tabId, dialog));
      }
    }
    let target = { ...rawTarget };
    delete target.frame;
    const frameMatch = typeof rawTarget.frame === "string" && rawTarget.frame !== "" ? rawTarget.frame : null;
    const resolveTarget = async () => {
      if (frameMatch && typeof tabId === "number") {
        target = { tabId, sessionId: (await this.resolveFrame(tabId, frameMatch)).sessionId };
      }
    };
    await resolveTarget();
    // A dialog opened by an iframe must be answered in that iframe's session.
    if (params.method === "Page.handleJavaScriptDialog" && typeof tabId === "number" && !target.sessionId) {
      const dialogSession = this.dialogsByTabId.get(tabId)?.sessionId;
      if (dialogSession) {
        target = { tabId, sessionId: dialogSession };
      }
    }
    const send = async () => {
      if (params.method === "Target.getTargets") {
        return { targetInfos: await chrome.debugger.getTargets() };
      }
      if (typeof params.method !== "string") {
        throw new Error("executeCdp requires method");
      }
      const commandParams = params.commandParams ?? {};
      if (params.method === "Emulation.setFocusEmulationEnabled" && typeof tabId === "number" && !target.sessionId) {
        await this.setFocusEmulation(tabId, commandParams.enabled === true);
        return {};
      }
      try {
        return await chrome.debugger.sendCommand(target, params.method, commandParams);
      } catch (error) {
        // "not attached" means the command never ran, so re-attaching and
        // retrying once is safe. "Detached while handling command" is not
        // retried: the command (e.g. a submit click) may already have run.
        if (typeof tabId !== "number" || !isDebuggerNotAttachedError(error)) {
          throw error;
        }
        this.attachedTabs.delete(tabId);
        this.framesByTabId.delete(tabId);
        await this.ensureAttached(tabId);
        await resolveTarget();
        return await chrome.debugger.sendCommand(target, params.method, commandParams);
      }
    };
    try {
      const result = await withTimeout(timeoutMs, () =>
        params.method === "Page.captureScreenshot" && typeof tabId === "number"
          ? this.withTabVisible(tabId, send)
          : send()
      );
      if (params.method === "Page.handleJavaScriptDialog" && typeof tabId === "number") {
        this.dialogsByTabId.delete(tabId);
      }
      return result;
    } catch (error) {
      // A command that opens a dialog (a click on a button that calls alert())
      // never returns; say why instead of reporting a bare timeout.
      const dialog = typeof tabId === "number" ? this.dialogsByTabId.get(tabId) : null;
      if (dialog && params.method !== "Page.handleJavaScriptDialog") {
        throw new Error(`${dialogBlockedMessage(tabId, dialog)} The ${params.method} command may already have run.`);
      }
      throw error;
    }
  }

  // Run a command through chrome.scripting / chrome.tabs instead of the
  // debugger. Results keep the CDP shape and carry a fallback marker.
  async executeWithoutDebugger(tabId, method, commandParams, attachError) {
    const fallback = { fallback: "no-debugger", reason: String(attachError?.message ?? attachError) };
    switch (method) {
      case "Runtime.evaluate": {
        if (typeof commandParams.expression !== "string") {
          throw new Error("Runtime.evaluate requires expression");
        }
        let injection;
        try {
          [injection] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            args: [commandParams.expression],
            // Indirect eval runs in global scope like Runtime.evaluate. A page
            // CSP without 'unsafe-eval' blocks it; that error is returned.
            func: (expression) => (0, eval)(expression)
          });
        } catch (error) {
          throw new Error(`${fallback.reason} The scripting fallback failed too: ${String(error?.message ?? error)}`);
        }
        const value = injection?.result;
        return {
          result: value === undefined ? { type: "undefined" } : { type: value === null ? "object" : typeof value, value },
          ...fallback
        };
      }
      case "Page.navigate": {
        if (typeof commandParams.url !== "string") {
          throw new Error("Page.navigate requires url");
        }
        await chrome.tabs.update(tabId, { url: commandParams.url });
        return { frameId: "", ...fallback };
      }
      case "Page.reload":
        await chrome.tabs.reload(tabId, { bypassCache: commandParams.ignoreCache === true });
        return { ...fallback };
      case "Page.captureScreenshot": {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) {
          throw new Error(
            `${fallback.reason} The screenshot fallback (captureVisibleTab) only works on the active tab of its window, and tab ${tabId} is in the background.`
          );
        }
        const format = commandParams.format === "jpeg" ? "jpeg" : "png";
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format,
          ...(format === "jpeg" && typeof commandParams.quality === "number" ? { quality: commandParams.quality } : {})
        });
        return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), ...fallback };
      }
      default:
        throw attachError;
    }
  }

  // Chromium stops painting hidden tabs, so Page.captureScreenshot on a
  // background tab hangs or returns a blank frame. Switch to the tab within its
  // window for the capture and switch back; the window is not focused. When
  // that window is the one the user is in, the swap shows for a moment, so
  // agents that screenshot often should use open-tab --new-window.
  async withTabVisible(tabId, fn) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && typeof tab.windowId === "number") {
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      if (win?.state === "minimized") {
        throw new Error(
          `Tab ${tabId} is in a minimized window, and Chrome does not paint minimized windows, so the screenshot would hang. ` +
            "Restore the window, or read the page with page-info / Runtime.evaluate instead."
        );
      }
    }
    if (!tab || tab.active || typeof tab.windowId !== "number") {
      return await fn();
    }
    const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
    await chrome.tabs.update(tabId, { active: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, TAB_PAINT_DELAY_MS));
      return await fn();
    } finally {
      if (hasTabId(previous) && previous.id !== tabId) {
        await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
      }
    }
  }

  async webmcp_list_tools(params) {
    const tabId = requireWebMcpTabId(params, "webmcp_list_tools");
    await this.requireSessionTab({ ...params, tabId }, "webmcp_list_tools");
    await this.requireWebMcpEnabled();
    const result = await this.sendWebMcpRequest(
      tabId,
      { action: "list" },
      DEFAULT_WEBMCP_LIST_TIMEOUT_MS + WEBMCP_TIMEOUT_GRACE_MS
    );
    if (!result || typeof result !== "object" || !Array.isArray(result.tools)) {
      throw new Error("WebMCP list response did not include tools");
    }
    return result;
  }

  async webmcp_invoke_tool(params) {
    const tabId = requireWebMcpTabId(params, "webmcp_invoke_tool");
    await this.requireSessionTab({ ...params, tabId }, "webmcp_invoke_tool");
    await this.requireWebMcpEnabled();
    const toolName = requireNonEmptyString(params.tool_name, "webmcp_invoke_tool requires tool_name");
    const registrationId = requireNonEmptyString(
      params.registration_id,
      "webmcp_invoke_tool requires registration_id"
    );
    if (!Object.hasOwn(params, "input")) {
      throw new Error("webmcp_invoke_tool requires input");
    }
    const timeoutMs = optionalPositiveInteger(
      params.timeout_ms,
      DEFAULT_WEBMCP_TIMEOUT_MS,
      "webmcp_invoke_tool timeout_ms"
    );
    const result = await this.sendWebMcpRequest(
      tabId,
      {
        action: "invoke",
        tool_name: toolName.trim(),
        ...(typeof params.tool_description === "string"
          ? { tool_description: params.tool_description }
          : {}),
        ...(typeof params.tool_title === "string" ? { tool_title: params.tool_title } : {}),
        registration_id: registrationId.trim(),
        input: params.input,
        timeout_ms: timeoutMs
      },
      timeoutMs + WEBMCP_TIMEOUT_GRACE_MS
    );
    if (!result || typeof result !== "object" || !Object.hasOwn(result, "result")) {
      throw new Error("WebMCP invoke response did not include result");
    }
    return result;
  }

  async moveMouse(params) {
    const session = await this.requireSession(params);
    await this.requireSessionTab(params, "moveMouse");
    const tabId = requireTabId(params, "moveMouse");
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
      throw new Error("moveMouse requires finite x and y");
    }
    const cursorReady = await this.ensureCursorContentScript(session.sessionId, tabId);
    if (!cursorReady) {
      throw new Error(`Cannot inject cursor content script into tab ${tabId}`);
    }
    const moveSequence = this.nextCursorMoveSequence;
    this.nextCursorMoveSequence += 1;
    const cursor = {
      moveSequence,
      visible: true,
      x: params.x,
      y: params.y
    };
    this.cursorByTabId.set(tabId, cursor);
    const arrivalWaiter =
      params.waitForArrival === false
        ? null
        : this.createCursorArrivalWaiter(params.session_id, params.turn_id, moveSequence);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_CURSOR",
        sessionId: params.session_id,
        turnId: params.turn_id,
        moveSequence,
        x: cursor.x,
        y: cursor.y,
        visible: cursor.visible
      });
      await arrivalWaiter?.promise;
    } catch (error) {
      arrivalWaiter?.cancel();
      throw error;
    }
  }

  async waitForFileChooser(params) {
    await this.requireSessionTab(params, "waitForFileChooser");
    const tabId = requireTabId(params, "waitForFileChooser");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const waitForEvent = this.waitForFileChooserEvent(tabId);
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", {
        enabled: true
      });
      return await withTimeout(timeoutMs, () => waitForEvent);
    } finally {
      this.fileChooserWaitersByTabId.delete(tabId);
      await chrome.debugger
        .sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => {});
    }
  }

  async setFileChooserFiles(params) {
    await this.requireSession(params);
    if (typeof params.fileChooserId !== "string" || params.fileChooserId === "") {
      throw new Error("setFileChooserFiles requires fileChooserId");
    }
    const chooser = this.fileChoosersById.get(params.fileChooserId);
    if (!chooser) {
      throw new Error(`Unknown file chooser id "${params.fileChooserId}"`);
    }
    await this.requireSessionTab({ ...params, tabId: chooser.tabId }, "setFileChooserFiles");
    if (!Array.isArray(params.files) || params.files.length === 0) {
      throw new Error("setFileChooserFiles requires at least one file");
    }
    const files = params.files.map((file) => {
      if (typeof file !== "string" || file === "") {
        throw new Error("setFileChooserFiles files must be non-empty strings");
      }
      return file;
    });
    if (!chooser.isMultiple && files.length > 1) {
      throw new Error("File chooser does not accept multiple files");
    }
    await chrome.debugger.sendCommand({ tabId: chooser.tabId }, "DOM.setFileInputFiles", {
      backendNodeId: chooser.backendNodeId,
      files
    });
    this.fileChoosersById.delete(params.fileChooserId);
  }

  async waitForDownload(params) {
    await this.requireSessionTab(params, "waitForDownload");
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const download = await this.waitForDownloadChange(
      (change) =>
        change.status === "started" ||
        change.status === "in_progress" ||
        change.status === "complete",
      timeoutMs,
      "Timed out waiting for download."
    );
    return { downloadId: download.id };
  }

  async downloadPath(params) {
    await this.requireSession(params);
    if (typeof params.downloadId !== "string" || params.downloadId === "") {
      throw new Error("downloadPath requires downloadId");
    }
    const current = this.downloadsById.get(params.downloadId);
    if (current?.status === "complete") {
      return { path: current.filename ?? null };
    }
    if (current?.status === "failed" || current?.status === "canceled") {
      return { path: null };
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const download = await this.waitForDownloadChange(
      (change) =>
        change.id === params.downloadId &&
        (change.status === "complete" || change.status === "failed" || change.status === "canceled"),
      timeoutMs,
      `Timed out waiting for download ${params.downloadId}.`
    );
    return { path: download.status === "complete" ? download.filename ?? null : null };
  }

  async readClipboardText(params) {
    await this.requireSessionTab(params, "readClipboardText");
    const tabId = requireTabId(params, "readClipboardText");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const text = await this.evaluateJavascript(tabId, "navigator.clipboard.readText()", true);
    return { text: typeof text === "string" ? text : "" };
  }

  async writeClipboardText(params) {
    await this.requireSessionTab(params, "writeClipboardText");
    const tabId = requireTabId(params, "writeClipboardText");
    if (typeof params.text !== "string") {
      throw new Error("writeClipboardText requires text");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(tabId, `navigator.clipboard.writeText(${JSON.stringify(params.text)})`, true);
  }

  async readClipboard(params) {
    await this.requireSessionTab(params, "readClipboard");
    const tabId = requireTabId(params, "readClipboard");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const items = await this.evaluateJavascript(
      tabId,
      `((async () => {
        const clipboardItems = await navigator.clipboard.read();
        return await Promise.all(clipboardItems.map(async (item) => {
          const entries = await Promise.all(item.types.map(async (type) => {
            const blob = await item.getType(type);
            if (type.startsWith("text/")) {
              return { mime_type: type, text: await blob.text() };
            }
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error);
              reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
              reader.readAsDataURL(blob);
            });
            return { mime_type: type, base64 };
          }));
          return { entries, presentation_style: item.presentationStyle ?? "unspecified" };
        }));
      })())`,
      true
    );
    return { items: Array.isArray(items) ? items : [] };
  }

  async writeClipboard(params) {
    await this.requireSessionTab(params, "writeClipboard");
    const tabId = requireTabId(params, "writeClipboard");
    if (!Array.isArray(params.items)) {
      throw new Error("writeClipboard requires items");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(
      tabId,
      `((async (items) => {
        const clipboardItems = items.map((item) => {
          const entries = {};
          for (const entry of item.entries ?? []) {
            const mime = entry.mime_type;
            if (!mime) continue;
            if (entry.text !== undefined) {
              entries[mime] = new Blob([entry.text], { type: mime });
            } else if (entry.base64 !== undefined) {
              const binary = atob(entry.base64);
              const bytes = new Uint8Array(binary.length);
              for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
              }
              entries[mime] = new Blob([bytes], { type: mime });
            }
          }
          return new ClipboardItem(entries, { presentationStyle: item.presentation_style ?? "unspecified" });
        });
        await navigator.clipboard.write(clipboardItems);
      })(${JSON.stringify(params.items)}))`,
      true
    );
  }

  async turnEnded(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    await this.detachMany(tabs.filter(hasTabId).map((tab) => tab.id));
    this.activeTabsBySession.delete(session.sessionId);
    for (const tab of tabs) {
      if (hasTabId(tab)) {
        this.cursorByTabId.delete(tab.id);
      }
    }
    const sessionState = await this.store.getSession(session.sessionId);
    sessionState.activeTabId = null;
    await this.store.save();
    await Promise.allSettled(tabs.filter(hasTabId).map((tab) => this.publishCursorState(tab.id)));
  }

  async executeUnhandledCommand(params) {
    throw new Error(`Open Browser Use Chrome does not support command "${params.type}"`);
  }

  addDownloadChangeListener(listener) {
    this.downloadChangeListeners.add(listener);
    return () => this.downloadChangeListeners.delete(listener);
  }

  handleDownloadCreated(item) {
    if (!this.isBrowserControlActive() || !Number.isInteger(item?.id)) {
      return;
    }
    const filename = typeof item.filename === "string" ? item.filename : "";
    const url =
      typeof item.finalUrl === "string" ? item.finalUrl : typeof item.url === "string" ? item.url : "";
    this.downloadFilenamesById.set(item.id, filename);
    this.downloadUrlsById.set(item.id, url);
    this.emitDownloadChange({
      id: String(item.id),
      filename,
      url,
      status: "started"
    });
  }

  handleDownloadChanged(delta) {
    if (!Number.isInteger(delta?.id)) {
      return;
    }
    const filename =
      typeof delta.filename?.current === "string"
        ? delta.filename.current
        : this.downloadFilenamesById.get(delta.id);
    const url = this.downloadUrlsById.get(delta.id);
    if (typeof filename !== "string" || typeof url !== "string") {
      return;
    }
    this.downloadFilenamesById.set(delta.id, filename);
    const status = downloadStatus(delta);
    if (!status) {
      return;
    }
    this.emitDownloadChange({
      id: String(delta.id),
      filename,
      url,
      status
    });
    if (status === "complete" || status === "failed" || status === "canceled") {
      this.downloadFilenamesById.delete(delta.id);
      this.downloadUrlsById.delete(delta.id);
    }
  }

  notifyCursorArrived(params) {
    const moveSequence = params?.moveSequence;
    if (!Number.isInteger(moveSequence)) {
      return false;
    }
    const waiter = this.cursorArrivalWaitersByKey.get(cursorArrivalKey(params.sessionId, params.turnId, moveSequence));
    waiter?.();
    return Boolean(waiter);
  }

  handleCdpEvent(source, method, params) {
    if (typeof source?.tabId !== "number") {
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      this.dialogsByTabId.set(source.tabId, {
        type: params?.type ?? "alert",
        message: String(params?.message ?? ""),
        ...(source.sessionId ? { sessionId: source.sessionId } : {})
      });
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      this.dialogsByTabId.delete(source.tabId);
      return;
    }
    if (method === "Target.attachedToTarget" && params?.sessionId) {
      const info = params.targetInfo ?? {};
      let frames = this.framesByTabId.get(source.tabId);
      if (!frames) {
        frames = new Map();
        this.framesByTabId.set(source.tabId, frames);
      }
      frames.set(params.sessionId, {
        sessionId: params.sessionId,
        targetId: info.targetId,
        type: info.type,
        url: info.url ?? "",
        title: info.title ?? "",
        ...(source.sessionId ? { parentSessionId: source.sessionId } : {})
      });
      if (info.type === "iframe") {
        // Dialog events and nested cross-site iframes need the same setup.
        const child = { tabId: source.tabId, sessionId: params.sessionId };
        chrome.debugger.sendCommand(child, "Page.enable", {}).catch(() => {});
        this.enableFrameAttach(child);
      }
      return;
    }
    if (method === "Target.detachedFromTarget" && params?.sessionId) {
      this.framesByTabId.get(source.tabId)?.delete(params.sessionId);
      return;
    }
    if (method === "Target.targetInfoChanged" && params?.targetInfo) {
      for (const frame of this.framesByTabId.get(source.tabId)?.values() ?? []) {
        if (frame.targetId === params.targetInfo.targetId) {
          frame.url = params.targetInfo.url ?? frame.url;
          frame.title = params.targetInfo.title ?? frame.title;
        }
      }
      return;
    }
    if (method !== "Page.fileChooserOpened") {
      return;
    }
    const waiter = this.fileChooserWaitersByTabId.get(source.tabId);
    waiter?.resolve(params ?? {});
  }

  waitForFileChooserEvent(tabId) {
    if (this.fileChooserWaitersByTabId.has(tabId)) {
      throw new Error(`Already waiting for file chooser in tab ${tabId}`);
    }
    return new Promise((resolve, reject) => {
      this.fileChooserWaitersByTabId.set(tabId, {
        resolve: (event) => {
          this.fileChooserWaitersByTabId.delete(tabId);
          if (!Number.isInteger(event.backendNodeId)) {
            reject(new Error("File chooser event did not include backendNodeId"));
            return;
          }
          const fileChooserId = crypto.randomUUID();
          const chooser = {
            tabId,
            backendNodeId: event.backendNodeId,
            isMultiple: event.mode === "selectMultiple"
          };
          this.fileChoosersById.set(fileChooserId, chooser);
          resolve({
            fileChooserId,
            isMultiple: chooser.isMultiple
          });
        }
      });
    });
  }

  readCursorOverlayState(tabId) {
    for (const [sessionId, activeTabId] of this.activeTabsBySession) {
      if (activeTabId === tabId) {
        return {
          cursor: this.cursorByTabId.get(tabId) ?? null,
          isVisible: true,
          sessionId,
          turnId: null
        };
      }
    }
    return {
      cursor: null,
      isVisible: false,
      sessionId: null,
      turnId: null
    };
  }

  isBrowserControlActive() {
    return this.activeTabsBySession.size > 0;
  }

  createCursorArrivalWaiter(sessionId, turnId, moveSequence) {
    const key = cursorArrivalKey(sessionId, turnId, moveSequence);
    let timeoutId;
    let resolvePromise;
    const resolve = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      this.cursorArrivalWaitersByKey.delete(key);
      resolvePromise?.();
    };
    const promise = new Promise((resolveInner) => {
      resolvePromise = resolveInner;
      timeoutId = setTimeout(resolve, CURSOR_ARRIVAL_TIMEOUT_MS);
      this.cursorArrivalWaitersByKey.set(key, resolve);
    });
    return { promise, cancel: resolve };
  }

  emitDownloadChange(change) {
    this.downloadsById.set(change.id, {
      ...(this.downloadsById.get(change.id) ?? {}),
      ...change
    });
    for (const waiter of [...this.downloadWaiters]) {
      if (waiter.predicate(change)) {
        waiter.resolve(change);
      }
    }
    for (const listener of this.downloadChangeListeners) {
      listener(change);
    }
  }

  waitForDownloadChange(predicate, timeoutMs, timeoutMessage) {
    for (const change of this.downloadsById.values()) {
      if (predicate(change)) {
        return Promise.resolve(change);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (change) => {
          cleanup();
          resolve(change);
        }
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.downloadWaiters.delete(waiter);
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.downloadWaiters.add(waiter);
    });
  }

  async evaluateJavascript(tabId, expression, awaitPromise) {
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "JavaScript evaluation failed");
    }
    return result.result?.value;
  }

  // Popup support: a snapshot of live agent sessions and user kill switches.
  async popupState() {
    await this.store.ready;
    const sessions = [];
    for (const [sessionId, session] of Object.entries(this.store.state.sessions)) {
      if (typeof session?.chromeGroupId !== "number") {
        continue;
      }
      const group = await chrome.tabGroups.get(session.chromeGroupId).catch(() => null);
      if (!group) {
        continue;
      }
      const tabs = await chrome.tabs.query({ groupId: session.chromeGroupId }).catch(() => []);
      if (tabs.length === 0) {
        continue;
      }
      const activeTabId = this.activeTabsBySession.get(sessionId) ?? session.activeTabId;
      sessions.push({
        sessionId,
        title: group.title || session.title,
        groupId: session.chromeGroupId,
        windowId: group.windowId,
        createdAt: typeof session.createdAt === "number" ? session.createdAt : null,
        lastActivity: this.lastActivityBySession.get(sessionId) ?? null,
        tabs: tabs.filter(hasTabId).map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl,
          controlled: this.attachedTabs.has(tab.id),
          agentActive: tab.id === activeTabId
        }))
      });
    }
    // Tabs agents handed back when they finished (moveToDeliverables).
    const resultGroups = await chrome.tabGroups.query({ title: DELIVERABLE_GROUP_TITLE }).catch(() => []);
    const results = [];
    for (const group of resultGroups) {
      const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
      for (const tab of tabs.filter(hasTabId)) {
        results.push({ id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, windowId: tab.windowId });
      }
    }
    return {
      webMcpEnabled: (await this.webMcpGate?.enabled?.()) === true,
      sessions,
      results
    };
  }

  async releaseTab(tabId) {
    await this.store.ready;
    await this.detachTab(tabId).catch(() => {});
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      if (owner) {
        await chrome.tabs.ungroup(tabId).catch(() => {});
        delete owner.session.tabOrigins?.[String(tabId)];
        await this.store.save();
      }
    }
  }

  async endSession(sessionId) {
    await this.store.ready;
    const session = this.store.state.sessions[sessionId];
    if (!session) {
      return;
    }
    if (typeof session.chromeGroupId === "number") {
      const tabs = await chrome.tabs.query({ groupId: session.chromeGroupId }).catch(() => []);
      const ids = tabs.filter(hasTabId).map((tab) => tab.id);
      await this.detachMany(ids).catch(() => {});
      if (ids.length > 0) {
        await chrome.tabs.ungroup(ids).catch(() => {});
      }
    }
    this.activeTabsBySession.delete(sessionId);
    this.lastActivityBySession.delete(sessionId);
    await this.store.removeSession(sessionId);
  }

  async ensureSessionGroup(sessionId, tabId, origin) {
    const session = await this.store.getSession(sessionId);
    let groupId = session.chromeGroupId;
    if (typeof groupId === "number") {
      try {
        await chrome.tabGroups.get(groupId);
        await chrome.tabs.group({ groupId, tabIds: [tabId] });
      } catch {
        groupId = null;
      }
    }
    if (typeof groupId !== "number") {
      // Without a windowId Chrome may create the group in the last focused
      // window and move the tab there.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      groupId = await chrome.tabs.group(
        typeof tab?.windowId === "number"
          ? { tabIds: [tabId], createProperties: { windowId: tab.windowId } }
          : { tabIds: [tabId] }
      );
      session.chromeGroupId = groupId;
    }
    session.tabOrigins[String(tabId)] = origin;
    await this.store.save();
    await chrome.tabGroups.update(groupId, {
      title: session.title,
      color: "blue",
      collapsed: false
    });
  }

  async setSessionActiveTab(sessionId, tabId) {
    const session = await this.store.getSession(sessionId);
    session.activeTabId = tabId;
    this.activeTabsBySession.set(sessionId, tabId);
    await this.store.save();
    await this.publishCursorState(tabId);
  }

  async getSessionTabs(sessionId, { includeInternal = false } = {}) {
    const session = await this.store.getSession(sessionId);
    if (typeof session.chromeGroupId !== "number") {
      return [];
    }
    try {
      return (await chrome.tabs.query({ groupId: session.chromeGroupId })).filter(
        (tab) => hasTabId(tab) && (includeInternal || !isInternalTab(tab))
      );
    } catch {
      await this.store.removeSession(sessionId);
      return [];
    }
  }

  async requireSession(params) {
    if (!params || typeof params !== "object") {
      throw new Error("Missing browser session params");
    }
    if (typeof params.session_id !== "string") {
      throw new Error("Missing required browser session_id");
    }
    if (typeof params.turn_id !== "string") {
      throw new Error("Missing required browser turn_id");
    }
    await this.store.getSession(params.session_id);
    this.lastActivityBySession.set(params.session_id, Date.now());
    return { sessionId: params.session_id, turnId: params.turn_id };
  }

  async requireSessionTab(params, command) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, command);
    const tabs = await this.getSessionTabs(session.sessionId, { includeInternal: true });
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new Error(await this.notInSessionMessage(tabId, session.sessionId));
    }
    if (isInternalTab(tab)) {
      throw new Error(
        `Tab ${tabId} shows ${tab.url}; Chrome does not let extensions control chrome:// pages. Use another tab, or open-tab --url with a web page; finalize-tabs still closes this one.`
      );
    }
  }

  // Say why a tab is not in the session: closed, replaced, owned by another
  // session, or simply never claimed.
  async notInSessionMessage(tabId, sessionId) {
    const base = `Tab ${tabId} is not part of browser session ${sessionId}`;
    const lost = this.lostTabs.get(tabId);
    if (lost?.reason === "replaced" && typeof lost.replacedBy === "number") {
      return `${base}: Chrome replaced it with tab ${lost.replacedBy} (a prerender or redirect swap)${
        lost.sessionId === sessionId ? `, which is in this session. Use --tab-id ${lost.replacedBy}.` : "."
      }`;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      const ago = lost ? ` ${Math.max(1, Math.round((Date.now() - lost.at) / 1000))}s ago` : "";
      return `${base}: the tab no longer exists (closed${ago}, by the user, the page, or finalize-tabs). Run obu tabs and user-tabs to pick another.`;
    }
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      if (owner && owner.sessionId !== sessionId) {
        return `${base}: it belongs to session ${owner.sessionId}. Take it over with: obu claim-tab --tab-id ${tabId} --force`;
      }
    }
    return `${base}: it is not in the session's tab group (it was released, ungrouped, or never claimed). Claim it with: obu claim-tab --tab-id ${tabId}`;
  }

  async withLogicalActive(sessionId, tabs) {
    if (tabs.length === 0) {
      return tabs;
    }
    const session = await this.store.getSession(sessionId);
    let activeTabId = this.activeTabsBySession.get(sessionId) ?? session.activeTabId;
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0].id;
      await this.setSessionActiveTab(sessionId, activeTabId);
    } else if (!this.activeTabsBySession.has(sessionId)) {
      this.activeTabsBySession.set(sessionId, activeTabId);
    }
    return tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId }));
  }

  async moveToDeliverables(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      return;
    }

    const tabRecords = await Promise.all(
      tabIds.map((id) => chrome.tabs.get(id).catch(() => null))
    );
    const tabsByWindow = new Map();
    for (const tab of tabRecords) {
      if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") continue;
      const arr = tabsByWindow.get(tab.windowId) ?? [];
      arr.push(tab.id);
      tabsByWindow.set(tab.windowId, arr);
    }
    if (tabsByWindow.size === 0) {
      return;
    }

    const storedGroupId = this.store.state.deliverableGroupId;
    let lastGroupId = null;

    for (const [windowId, windowTabIds] of tabsByWindow) {
      const existingGroups = await chrome.tabGroups
        .query({ windowId, title: DELIVERABLE_GROUP_TITLE })
        .catch(() => []);

      let primaryGroupId = null;
      if (existingGroups.length > 0) {
        const preferred =
          existingGroups.find((g) => g.id === storedGroupId) ??
          existingGroups.reduce((min, g) => (g.id < min.id ? g : min), existingGroups[0]);
        primaryGroupId = preferred.id;

        for (const group of existingGroups) {
          if (group.id === primaryGroupId) continue;
          const dupTabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
          const dupTabIds = dupTabs
            .map((t) => t.id)
            .filter((id) => typeof id === "number");
          if (dupTabIds.length > 0) {
            await chrome.tabs
              .group({ groupId: primaryGroupId, tabIds: dupTabIds })
              .catch(() => {});
          }
        }
      }

      if (typeof primaryGroupId === "number") {
        try {
          await chrome.tabs.group({ groupId: primaryGroupId, tabIds: windowTabIds });
        } catch {
          primaryGroupId = null;
        }
      }

      if (typeof primaryGroupId !== "number") {
        primaryGroupId = await chrome.tabs.group({ tabIds: windowTabIds });
      }

      await chrome.tabGroups
        .update(primaryGroupId, {
          title: DELIVERABLE_GROUP_TITLE,
          color: "green",
          collapsed: false
        })
        .catch(() => {});

      lastGroupId = primaryGroupId;
    }

    if (typeof lastGroupId === "number") {
      this.store.state.deliverableGroupId = lastGroupId;
      await this.store.save();
    }
  }

  async detachMany(tabIds) {
    await Promise.allSettled(tabIds.map((tabId) => this.detachTab(tabId)));
  }

  async detachTab(tabId) {
    try {
      await chrome.debugger.detach({ tabId });
    } finally {
      this.attachedTabs.delete(tabId);
      this.framesByTabId.delete(tabId);
      for (const [fileChooserId, chooser] of this.fileChoosersById) {
        if (chooser.tabId === tabId) {
          this.fileChoosersById.delete(fileChooserId);
        }
      }
      this.cursorByTabId.delete(tabId);
    }
  }

  async ensureCursorContentScript(sessionId, tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "OPEN_BROWSER_USE_PING" });
      if (response?.ok) {
        return true;
      }
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-cursor.js"]
      });
      return true;
    } catch {
      return false;
    }
  }

  async requireWebMcpEnabled() {
    if ((await this.webMcpGate?.enabled?.()) !== true) {
      throw new Error("WebMCP capability is disabled");
    }
  }

  async sendWebMcpRequest(tabId, request, timeoutMs) {
    await this.ensureWebMcpContentScripts(tabId);
    const response = await withWebMcpTimeout(timeoutMs, async () => {
      return await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_REQUEST",
        ...request
      });
    });
    if (response?.ok !== true) {
      throw new Error(
        typeof response?.error === "string" ? response.error : "WebMCP page bridge request failed"
      );
    }
    return response.result;
  }

  async ensureWebMcpContentScripts(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_PING"
      });
      if (response?.ok === true) {
        return;
      }
    } catch {}

    try {
      await chrome.scripting.executeScript({
        files: ["content-webmcp-main.js"],
        target: { tabId },
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        files: ["content-webmcp-bridge.js"],
        target: { tabId },
        world: "ISOLATED"
      });
    } catch (error) {
      throw new Error(
        `Cannot inject WebMCP bridge into tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_PING"
      });
      if (response?.ok === true) {
        return;
      }
    } catch {}
    throw new Error(`WebMCP bridge is unavailable in tab ${tabId}`);
  }

  async publishCursorState(tabId) {
    if (!(await this.ensureCursorContentScript(null, tabId))) {
      return false;
    }
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_CURSOR_STATE",
        state: this.readCursorOverlayState(tabId)
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }
}

function hasTabId(tab) {
  return typeof tab?.id === "number";
}

function toBrowserTab(tab) {
  return {
    id: tab.id,
    title: tab.title,
    active: tab.active,
    url: tab.url
  };
}

function toUserTab(tab, groupTitles) {
  const lastAccessed =
    typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed)
      ? new Date(tab.lastAccessed).toISOString()
      : undefined;
  const groupTitle =
    typeof tab.groupId === "number" && tab.groupId !== -1 ? groupTitles.get(tab.groupId) : undefined;
  return {
    id: tab.id,
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(lastAccessed ? { lastOpened: lastAccessed } : {}),
    ...(groupTitle ? { tabGroup: groupTitle } : {})
  };
}

function requireTabId(params, command) {
  if (!Number.isInteger(params.tabId)) {
    throw new Error(`${command} requires an integer tabId`);
  }
  return params.tabId;
}

function requireWebMcpTabId(params, command) {
  const candidate = params?.tabId ?? params?.tab_id;
  if (Number.isInteger(candidate) && candidate >= 0) {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${command} requires integer tabId`);
}

function requireNonEmptyString(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

function optionalPositiveInteger(value, fallback, field) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

async function createBackgroundTab() {
  const windowId = await chooseWindowId();
  if (typeof windowId === "number") {
    const tab = await chrome.tabs.create({ active: false, url: "about:blank", windowId });
    if (hasTabId(tab)) {
      return tab;
    }
  }
  const win = await chrome.windows.create({
    focused: false,
    type: "normal",
    url: "about:blank"
  });
  const tab = win.tabs?.find(hasTabId);
  if (!tab) {
    throw new Error("Created Chrome window has no tab");
  }
  return tab;
}

async function chooseWindowId() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = windows.find((win) => win.focused && typeof win.id === "number");
  return focused?.id ?? windows.find((win) => typeof win.id === "number")?.id ?? null;
}

async function readGroupTitles(tabs) {
  const ids = new Set(
    tabs
      .map((tab) => tab.groupId)
      .filter((groupId) => typeof groupId === "number" && groupId !== -1)
  );
  const entries = await Promise.all(
    [...ids].map(async (groupId) => {
      try {
        const group = await chrome.tabGroups.get(groupId);
        return group.title ? [groupId, group.title] : null;
      } catch {
        return null;
      }
    })
  );
  return new Map(entries.filter(Boolean));
}

function compareLastAccessed(left, right) {
  const byLastAccessed = (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
  if (byLastAccessed !== 0) {
    return byLastAccessed;
  }
  const byWindow = (left.windowId ?? 0) - (right.windowId ?? 0);
  return byWindow !== 0 ? byWindow : (left.index ?? 0) - (right.index ?? 0);
}

function parseDate(value, field) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`getUserHistory requires ${field} to be a valid date`);
  }
  return timestamp;
}

function downloadStatus(delta) {
  switch (delta.state?.current) {
    case "complete":
      return "complete";
    case "interrupted":
      return delta.error?.current === "USER_CANCELED" ? "canceled" : "failed";
    case "in_progress":
      return "in_progress";
    default:
      return undefined;
  }
}

function cursorArrivalKey(sessionId, turnId, moveSequence) {
  return `${sessionId}:${turnId}:${moveSequence}`;
}

// Chrome reports "Debugger is not attached to the tab with id: N." when the
// attachment is gone before a command is sent.
function isDebuggerNotAttachedError(error) {
  return /is not attached/i.test(String(error?.message ?? error));
}

const TAB_PAINT_DELAY_MS = 150;
const FRAME_ATTACH_SETTLE_MS = 300;
const FRAME_RESOLVE_WAIT_MS = 2_000;

const FOREIGN_ATTACH_RETRY_DELAYS_MS = [500, 1_500, 3_000];
const FOREIGN_ATTACH_COOLDOWN_MS = 5_000;
const DEBUGGER_FREE_METHODS = new Set(["Runtime.evaluate", "Page.navigate", "Page.reload", "Page.captureScreenshot"]);

// Chrome refuses chrome.debugger.attach while a frame from another extension
// is in the page.
function isForeignExtensionFrameError(error) {
  return /chrome-extension:\/\/ URL of different extension/i.test(String(error?.message ?? error));
}

// List chrome-extension:// iframes in the tab, including ones inside open
// shadow roots and inside frames we can script.
async function findExtensionFrames(tabId) {
  try {
    const injections = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const found = [];
        const visit = (root) => {
          for (const el of root.querySelectorAll("*")) {
            if ((el.tagName === "IFRAME" || el.tagName === "EMBED" || el.tagName === "OBJECT")) {
              const src = el.src || el.data || "";
              if (src.startsWith("chrome-extension://")) found.push(src);
            }
            if (el.shadowRoot) visit(el.shadowRoot);
          }
        };
        visit(document);
        return found;
      }
    });
    return [...new Set(injections.flatMap((injection) => injection?.result ?? []))];
  } catch {
    return [];
  }
}

function foreignFrameMessage(tabId, chromeMessage, frames) {
  const origins = [...new Set(frames.map((src) => src.split("/").slice(0, 3).join("/")))];
  const blocking = origins.length > 0
    ? `Another extension's frame is in the page (${origins.join(", ")}), and Chrome will not let a debugger attach while it is there.`
    : "Another extension's frame or popup is in or over the page, and Chrome will not let a debugger attach while it is there.";
  return (
    `${chromeMessage} (tab ${tabId}). ${blocking} ` +
    "Wait for it to close or close it (usually a password manager, wallet, or sign-in prompt), then retry. " +
    "Until then, Runtime.evaluate, Page.navigate, Page.reload, and screenshots of the active tab still work without the debugger."
  );
}

function isInternalTab(tab) {
  return /^(chrome|chrome-untrusted|devtools):\/\//.test(tab?.url ?? tab?.pendingUrl ?? "");
}

function dialogBlockedMessage(tabId, dialog) {
  const text = dialog.message.length > 200 ? `${dialog.message.slice(0, 200)}…` : dialog.message;
  return (
    `Tab ${tabId} is blocked by a JavaScript ${dialog.type} dialog: "${text}". ` +
    `Close it with: obu cdp --tab-id ${tabId} --method Page.handleJavaScriptDialog --params '{"accept":true}' ` +
    `(accept:false dismisses; add "promptText" for a prompt).`
  );
}

async function withTimeout(timeoutMs, fn) {
  let timeout;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(
            `Timed out after ${timeoutMs}ms waiting for CDP command. Chrome may still run it, or may already have: check the page before retrying an input, navigation, or script, or it can happen twice.`
          ));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function withWebMcpTimeout(timeoutMs, fn) {
  let timeout;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebMCP page bridge.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function startHeartbeat(peer, backend) {
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 0.5 }).catch(() => {});
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM_NAME) {
      safeSendNotification(peer, "heartbeat", { at: new Date().toISOString() });
      void backend.getInfo().catch(() => {});
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
  if (typeof extensionInstanceId !== "string") {
    await chrome.storage.local.set({ extensionInstanceId: crypto.randomUUID() });
  }
});

const webMcpGate = new WebMcpGate();
const backend = new BrowserBackend({ webMcpGate });
const transport = new NativeTransport(NATIVE_HOST_NAME);
const peer = new JsonRpcPeer(transport, backend);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_NATIVE_HOST_STATUS") {
    const status = transport.getStatus();
    sendResponse({ ok: status.state === "connected", status, error: status.error });
    return true;
  }
  if (message?.type === "GET_POPUP_STATE") {
    backend.popupState().then(
      (state) => sendResponse({ ok: true, status: transport.getStatus(), ...state }),
      (error) =>
        sendResponse({ ok: false, status: transport.getStatus(), error: String(error?.message ?? error) })
    );
    return true;
  }
  if (message?.type === "POPUP_ACTION" && sender.id === chrome.runtime.id && !sender.tab) {
    const run = async () => {
      if (message.action === "reconnect") {
        transport.connect();
      } else if (message.action === "releaseTab" && Number.isInteger(message.tabId)) {
        await backend.releaseTab(message.tabId);
      } else if (message.action === "endSession" && typeof message.sessionId === "string") {
        await backend.endSession(message.sessionId);
      } else {
        throw new Error("Unknown popup action");
      }
    };
    run().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error?.message ?? error) })
    );
    return true;
  }
  if (message?.type === "GET_OPEN_BROWSER_USE_CURSOR_STATE") {
    const tabId = typeof sender.tab?.id === "number" ? sender.tab.id : -1;
    sendResponse({ ok: true, state: backend.readCursorOverlayState(tabId) });
    return true;
  }
  if (message?.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED") {
    sendResponse({ ok: backend.notifyCursorArrived(message) });
    return true;
  }
  return false;
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  backend.handleCdpEvent(source, method, params);
  safeSendNotification(peer, "onCDPEvent", { source, method, params });
});
backend.addDownloadChangeListener((change) => {
  safeSendNotification(peer, "onDownloadChange", change);
});
chrome.downloads.onCreated.addListener((item) => {
  backend.handleDownloadCreated(item);
});
chrome.downloads.onChanged.addListener((delta) => {
  backend.handleDownloadChanged(delta);
});
startHeartbeat(peer, backend);

function safeSendNotification(peer, method, params) {
  try {
    peer.sendNotification(method, params);
  } catch {}
}
