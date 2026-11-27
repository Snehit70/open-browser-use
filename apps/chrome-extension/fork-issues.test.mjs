// Node test for tab ownership, lost-tab errors, foreign-extension attach
// failures, focus-emulation tracking, spawned-tab grouping, and screenshots of
// minimized windows.
// Run: node apps/chrome-extension/fork-issues.test.mjs

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BG_PATH = path.join(HERE, "background.js");

function permissive() {
  const fn = async () => undefined;
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "addListener") return () => {};
      return permissive();
    }
  });
}

function event() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), fire: (...args) => listeners.map((fn) => fn(...args)) };
}

function createChromeFake() {
  const state = {
    nextTabId: 1000,
    nextGroupId: 100,
    tabs: new Map(),
    groups: new Map(),
    windows: new Map([[1, { id: 1, focused: true, state: "normal" }]]),
    attached: new Set(),
    sent: [],
    // Errors chrome.debugger.attach throws next, in order.
    attachErrors: [],
    attachCalls: 0,
    scriptResults: [],
    storage: {}
  };
  const events = {
    onCreated: event(),
    onRemoved: event(),
    onReplaced: event(),
    onDetach: event()
  };
  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return key in state.storage ? { [key]: state.storage[key] } : {};
          return { ...state.storage };
        },
        async set(obj) {
          Object.assign(state.storage, structuredClone(obj));
        }
      }
    },
    tabs: {
      onCreated: events.onCreated,
      onRemoved: events.onRemoved,
      onReplaced: events.onReplaced,
      async get(tabId) {
        const tab = state.tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return { ...tab };
      },
      async query(filter = {}) {
        return [...state.tabs.values()]
          .filter((tab) => (typeof filter.groupId === "number" ? tab.groupId === filter.groupId : true))
          .filter((tab) => (filter.active === true ? tab.active : true))
          .filter((tab) => (typeof filter.windowId === "number" ? tab.windowId === filter.windowId : true))
          .map((tab) => ({ ...tab }));
      },
      async group({ groupId, tabIds }) {
        const id = typeof groupId === "number" ? groupId : state.nextGroupId++;
        if (!state.groups.has(id)) {
          if (typeof groupId === "number") throw new Error(`No group with id: ${groupId}.`);
          state.groups.set(id, { id, title: "" });
        }
        for (const tabId of [].concat(tabIds)) state.tabs.get(tabId).groupId = id;
        return id;
      },
      async ungroup(tabIds) {
        for (const tabId of [].concat(tabIds)) {
          const tab = state.tabs.get(tabId);
          if (tab) tab.groupId = -1;
        }
      },
      async update(tabId, props) {
        const tab = state.tabs.get(tabId);
        if (props.active) {
          for (const other of state.tabs.values()) if (other.windowId === tab.windowId) other.active = false;
          tab.active = true;
        }
        if (props.url) tab.url = props.url;
        return { ...tab };
      },
      async remove(tabIds) {
        for (const tabId of [].concat(tabIds)) state.tabs.delete(tabId);
      }
    },
    tabGroups: {
      async get(groupId) {
        const group = state.groups.get(groupId);
        if (!group) throw new Error(`No group with id: ${groupId}.`);
        return { ...group };
      },
      async update(groupId, props) {
        Object.assign(state.groups.get(groupId) ?? {}, props);
      }
    },
    windows: {
      async get(windowId) {
        const win = state.windows.get(windowId);
        if (!win) throw new Error(`No window with id: ${windowId}.`);
        return { ...win };
      }
    },
    scripting: {
      async executeScript(details) {
        state.lastScript = details;
        const next = state.scriptResults.shift();
        if (next instanceof Error) throw next;
        // "run" executes the injected function for real, as Chrome would.
        if (next === "run") return [{ result: await details.func(...(details.args ?? [])) }];
        return next ?? [{ result: undefined }];
      }
    },
    debugger: {
      async attach({ tabId }) {
        state.attachCalls++;
        const queued = state.attachErrors.shift();
        if (queued) throw new Error(queued);
        state.attached.add(tabId);
      },
      async detach({ tabId }) {
        state.attached.delete(tabId);
      },
      async sendCommand({ tabId }, method, params) {
        state.sent.push({ tabId, method, params });
        return {};
      },
      async getTargets() {
        return [];
      },
      onEvent: { addListener() {} },
      onDetach: events.onDetach
    }
  };
  return {
    chrome: new Proxy(chrome, { get: (target, prop) => (prop in target ? target[prop] : permissive()) }),
    state,
    events
  };
}

async function loadBackend() {
  const { chrome, state, events } = createChromeFake();
  const context = vm.createContext({
    chrome,
    console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    TextEncoder,
    TextDecoder,
    structuredClone,
    crypto: globalThis.crypto,
    Date
  });
  vm.runInContext(
    "chrome.runtime.connectNative = () => ({ onMessage: { addListener(){} }, onDisconnect: { addListener(){} }, postMessage(){}, disconnect(){} });",
    context
  );
  const source = await readFile(BG_PATH, "utf8");
  vm.runInContext(`${source}\nglobalThis.BrowserBackend = BrowserBackend;`, context);
  const backend = new context.BrowserBackend();
  await backend.store.ready;
  const addTab = (props = {}) => {
    const id = state.nextTabId++;
    state.tabs.set(id, { id, windowId: 1, groupId: -1, active: false, url: "https://example.com/", title: "t", ...props });
    return id;
  };
  return { backend, state, events, addTab };
}

const params = (sessionId, extra = {}) => ({ session_id: sessionId, turn_id: "turn", ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function run() {
  // claim-tab: a tab owned by an interrupted session can be taken over with
  // force, keeping its origin; without force the error names the way out.
  {
    const { backend, state, addTab } = await loadBackend();
    const tabId = addTab();
    await backend.claimUserTab(params("sess-A", { tabId }));
    await assert.rejects(backend.claimUserTab(params("sess-B", { tabId })), (error) => {
      assert.match(error.message, /already part of browser session sess-A/);
      assert.match(error.message, new RegExp(`claim-tab --tab-id ${tabId} --force`));
      return true;
    });
    await backend.claimUserTab(params("sess-B", { tabId, force: true }));
    const sessions = backend.store.state.sessions;
    assert.equal(sessions["sess-B"].tabOrigins[String(tabId)], "user");
    assert.equal(sessions["sess-A"].tabOrigins[String(tabId)], undefined);
    assert.equal(state.tabs.get(tabId).groupId, sessions["sess-B"].chromeGroupId);
    const listed = await backend.getTabs(params("sess-B"));
    assert.deepEqual(listed.map((tab) => tab.id), [tabId]);
    console.log("ok: claim-tab --force takes a tab over from another session");
  }

  // A takeover keeps an agent tab an agent tab, so finalize still closes it.
  {
    const { backend, addTab } = await loadBackend();
    const tabId = addTab();
    await backend.claimUserTab(params("sess-A", { tabId }));
    backend.store.state.sessions["sess-A"].tabOrigins[String(tabId)] = "agent";
    await backend.claimUserTab(params("sess-B", { tabId, force: true }));
    assert.equal(backend.store.state.sessions["sess-B"].tabOrigins[String(tabId)], "agent");
    console.log("ok: takeover keeps the tab's origin");
  }

  // user-tabs names the owning session.
  {
    const { backend, addTab } = await loadBackend();
    const claimed = addTab();
    const free = addTab();
    await backend.claimUserTab(params("sess-A", { tabId: claimed }));
    const tabs = await backend.getUserTabs(params("sess-X"));
    assert.equal(tabs.find((tab) => tab.id === claimed).sessionId, "sess-A");
    assert.equal(tabs.find((tab) => tab.id === free).sessionId, undefined);
    console.log("ok: user-tabs includes sessionId for claimed tabs");
  }

  // "not part of session" says what happened to the tab.
  {
    const { backend, state, events, addTab } = await loadBackend();
    const closed = addTab();
    const replaced = addTab();
    const foreign = addTab();
    const never = addTab();
    await backend.claimUserTab(params("s", { tabId: closed }));
    await backend.claimUserTab(params("s", { tabId: replaced }));
    await backend.claimUserTab(params("other", { tabId: foreign }));

    state.tabs.delete(closed);
    events.onRemoved.fire(closed, {});
    await settle();
    await assert.rejects(backend.requireSessionTab(params("s", { tabId: closed }), "x"), /no longer exists \(closed/);

    const newId = addTab({ groupId: -1 });
    state.tabs.delete(replaced);
    events.onReplaced.fire(newId, replaced);
    await settle();
    await assert.rejects(
      backend.requireSessionTab(params("s", { tabId: replaced }), "x"),
      new RegExp(`replaced it with tab ${newId}.*Use --tab-id ${newId}`)
    );
    // The replacement is in the session under its new id.
    assert.equal(backend.store.state.sessions.s.tabOrigins[String(newId)], "user");
    await backend.requireSessionTab(params("s", { tabId: newId }), "x");

    await assert.rejects(
      backend.requireSessionTab(params("s", { tabId: foreign }), "x"),
      /belongs to session other.*--force/
    );
    await assert.rejects(backend.requireSessionTab(params("s", { tabId: never }), "x"), /Claim it with: obu claim-tab/);
    console.log("ok: lost-tab errors explain closed, replaced, foreign, and unclaimed tabs");
  }

  // Attach refused by another extension's frame: retry, then name the frame.
  {
    const { backend, state, addTab } = await loadBackend();
    const tabId = addTab();
    await backend.claimUserTab(params("s", { tabId }));
    const refusal = "Cannot access a chrome-extension:// URL of different extension";
    state.attachErrors.push(refusal, refusal);
    await backend.ensureAttached(tabId);
    assert.equal(state.attachCalls, 3, "retries until the frame is gone");

    await backend.detachTab(tabId);
    state.attachCalls = 0;
    state.attachErrors.push(refusal, refusal, refusal, refusal);
    state.scriptResults.push([{ result: ["chrome-extension://abcdef/popup.html"] }, { result: [] }]);
    await assert.rejects(backend.ensureAttached(tabId), (error) => {
      assert.match(error.message, /chrome-extension:\/\/abcdef/);
      assert.match(error.message, /still work without the debugger/);
      return true;
    });
    assert.equal(state.attachCalls, 4);

    // A second command right after fails fast instead of waiting again.
    state.attachCalls = 0;
    state.attachErrors.push(refusal);
    state.scriptResults.push([{ result: [] }]);
    await assert.rejects(backend.ensureAttached(tabId));
    assert.equal(state.attachCalls, 1);

    // Runtime.evaluate falls back to chrome.scripting.
    state.attachErrors.push(refusal);
    state.scriptResults.push([{ result: [] }], "run");
    const result = await backend.executeCdp(
      params("s", { target: { tabId }, method: "Runtime.evaluate", commandParams: { expression: "({ok: 1+1})" } })
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { type: "object", value: { ok: 2 } });
    assert.equal(result.fallback, "no-debugger");
    assert.equal(state.lastScript.world, "MAIN");

    // A throw (or a CSP EvalError) comes back as exceptionDetails, not as an
    // empty undefined result.
    state.attachErrors.push(refusal);
    state.scriptResults.push([{ result: [] }], "run");
    const thrown = await backend.executeCdp(
      params("s", { target: { tabId }, method: "Runtime.evaluate", commandParams: { expression: "throw new TypeError('boom')" } })
    );
    assert.equal(thrown.exceptionDetails?.text, "Uncaught");
    assert.match(thrown.result.description, /TypeError: boom/);

    // A promise is awaited only with awaitPromise, like Runtime.evaluate.
    state.attachErrors.push(refusal);
    state.scriptResults.push([{ result: [] }], "run");
    const pending = await backend.executeCdp(
      params("s", { target: { tabId }, method: "Runtime.evaluate", commandParams: { expression: "Promise.resolve(5)" } })
    );
    assert.equal(pending.result.subtype, "promise");
    state.attachErrors.push(refusal);
    state.scriptResults.push([{ result: [] }], "run");
    const awaited = await backend.executeCdp(
      params("s", { target: { tabId }, method: "Runtime.evaluate", commandParams: { expression: "Promise.resolve(5)", awaitPromise: true } })
    );
    assert.equal(awaited.result.value, 5);
    console.log("ok: foreign-extension attach retries, names the frame, and falls back");
  }

  // The tab itself showing another extension's page fails at once.
  {
    const { backend, state, addTab } = await loadBackend();
    const tabId = addTab({ url: "chrome-extension://zzz/page.html" });
    await backend.claimUserTab(params("s", { tabId }));
    state.attachErrors.push("Cannot access a chrome-extension:// URL of different extension");
    await assert.rejects(backend.ensureAttached(tabId), /shows another extension's page \(chrome-extension:\/\/zzz\)/);
    assert.equal(state.attachCalls, 1);
    console.log("ok: a tab on another extension's page is reported, not retried");
  }

  // Focus emulation is tracked and reported by getTabState.
  {
    const { backend, state, addTab } = await loadBackend();
    const agentTab = addTab();
    const userTab = addTab({ active: true });
    await backend.claimUserTab(params("s", { tabId: agentTab }));
    backend.store.state.sessions.s.tabOrigins[String(agentTab)] = "agent";
    await backend.claimUserTab(params("s", { tabId: userTab }));
    await backend.ensureAttached(agentTab);
    await backend.ensureAttached(userTab);
    let tabState = await backend.getTabState(params("s", { tabId: agentTab }));
    assert.equal(tabState.focusEmulated, true);
    assert.equal(tabState.agentTab, true);
    assert.equal(tabState.visibleToUser, false);
    tabState = await backend.getTabState(params("s", { tabId: userTab }));
    assert.equal(tabState.focusEmulated, false);
    assert.equal(tabState.visibleToUser, true);

    await backend.executeCdp(
      params("s", { target: { tabId: userTab }, method: "Emulation.setFocusEmulationEnabled", commandParams: { enabled: true } })
    );
    assert.equal((await backend.getTabState(params("s", { tabId: userTab }))).focusEmulated, true);
    await backend.executeCdp(
      params("s", { target: { tabId: userTab }, method: "Emulation.setFocusEmulationEnabled", commandParams: { enabled: false } })
    );
    assert.equal((await backend.getTabState(params("s", { tabId: userTab }))).focusEmulated, false);
    assert.ok(state.sent.some((cmd) => cmd.method === "Emulation.setFocusEmulationEnabled" && cmd.params.enabled === false));

    // Detaching ends the emulation, so the report must not keep claiming it.
    await backend.detachTab(agentTab);
    tabState = await backend.getTabState(params("s", { tabId: agentTab }));
    assert.equal(tabState.focusEmulated, false);
    assert.equal(tabState.debuggerAttached, false);

    // Active in an unfocused window is in front there, not seen by the user.
    state.windows.set(1, { id: 1, focused: false, state: "normal" });
    tabState = await backend.getTabState(params("s", { tabId: userTab }));
    assert.equal(tabState.activeInWindow, true);
    assert.equal(tabState.visibleToUser, false);
    console.log("ok: focus emulation state is tracked and reported");
  }

  // A tab spawned by a session tab outside its group is pulled into the group:
  // always for agent tabs, and for a claimed user tab only right after agent
  // input. A tab the user opens from their own claimed tab stays theirs.
  {
    const { backend, state, events, addTab } = await loadBackend();
    const opener = addTab();
    await backend.claimUserTab(params("s", { tabId: opener }));
    const byUser = addTab({ openerTabId: opener, groupId: -1 });
    events.onCreated.fire({ ...state.tabs.get(byUser) });
    await settle();
    assert.equal(state.tabs.get(byUser).groupId, -1);
    assert.equal(backend.store.state.sessions.s.tabOrigins[String(byUser)], undefined);

    await backend.ensureAttached(opener);
    await backend.executeCdp(
      params("s", { target: { tabId: opener }, method: "Input.dispatchMouseEvent", commandParams: { type: "mousePressed", x: 1, y: 1 } })
    );
    const byAgent = addTab({ openerTabId: opener, groupId: -1 });
    events.onCreated.fire({ ...state.tabs.get(byAgent) });
    await settle();
    assert.equal(state.tabs.get(byAgent).groupId, backend.store.state.sessions.s.chromeGroupId);
    assert.equal(backend.store.state.sessions.s.tabOrigins[String(byAgent)], "agent");

    const agentOpener = addTab();
    await backend.claimUserTab(params("s", { tabId: agentOpener }));
    backend.store.state.sessions.s.tabOrigins[String(agentOpener)] = "agent";
    const fromAgentTab = addTab({ openerTabId: agentOpener, groupId: -1 });
    events.onCreated.fire({ ...state.tabs.get(fromAgentTab) });
    await settle();
    assert.equal(state.tabs.get(fromAgentTab).groupId, backend.store.state.sessions.s.chromeGroupId);
    console.log("ok: spawned tabs join the session only when the agent opened them");
  }

  // A --new-window session refuses to claim a tab from the user's window,
  // since grouping would move it into the agent window.
  {
    const { backend, state, addTab } = await loadBackend();
    state.windows.set(9, { id: 9, focused: false, state: "normal" });
    const agentTab = addTab({ windowId: 9 });
    await backend.claimUserTab(params("s", { tabId: agentTab }));
    backend.store.state.sessions.s.agentWindowId = 9;
    const userTab = addTab({ windowId: 1 });
    await assert.rejects(backend.claimUserTab(params("s", { tabId: userTab })), /separate window/);
    console.log("ok: claim refuses to move a user tab into the agent window");
  }

  // Screenshots in a minimized window fail with a reason instead of hanging.
  {
    const { backend, state, addTab } = await loadBackend();
    state.windows.set(2, { id: 2, focused: false, state: "minimized" });
    const tabId = addTab({ windowId: 2 });
    await backend.claimUserTab(params("s", { tabId }));
    await assert.rejects(
      backend.executeCdp(params("s", { target: { tabId }, method: "Page.captureScreenshot", commandParams: {} })),
      /minimized window/
    );
    console.log("ok: screenshots of minimized windows explain why they fail");
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
