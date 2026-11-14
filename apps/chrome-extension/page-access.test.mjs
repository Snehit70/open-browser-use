// Node test for page-access edge cases agents hit: JavaScript dialogs, chrome://
// tabs, tabs spawned by links, and screenshots of background tabs.
// Run: node apps/chrome-extension/page-access.test.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const BG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "background.js");

function permissive() {
  const fn = async () => undefined;
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "addListener") return () => {};
      return permissive();
    }
  });
}

function createChromeFake() {
  const state = {
    storage: {},
    tabs: new Map([
      [1, { id: 1, groupId: 9, windowId: 1, active: false, title: "A", url: "https://a.test/" }],
      [2, { id: 2, groupId: 9, windowId: 1, active: false, title: "Settings", url: "chrome://settings/" }],
      [3, { id: 3, groupId: -1, windowId: 1, active: true, title: "User", url: "https://u.test/" }]
    ]),
    removed: [],
    activations: [],
    sent: [],
    targets: [],
    // Called for each sendCommand; return a promise to control timing.
    onSend: null,
    onCreated: null
  };
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return typeof key === "string" && key in state.storage ? { [key]: state.storage[key] } : {};
        },
        async set(obj) {
          Object.assign(state.storage, structuredClone(obj));
        }
      }
    },
    tabs: {
      async get(id) {
        if (state.slowGet?.[id]) await new Promise((resolve) => setTimeout(resolve, state.slowGet[id]));
        if (!state.tabs.has(id)) throw new Error("No tab");
        return { ...state.tabs.get(id) };
      },
      async query({ groupId, active, windowId }) {
        return [...state.tabs.values()]
          .filter((tab) => (groupId === undefined || tab.groupId === groupId))
          .filter((tab) => (active === undefined || tab.active === active))
          .filter((tab) => (windowId === undefined || tab.windowId === windowId))
          .map((tab) => ({ ...tab }));
      },
      async update(id, { active }) {
        if (active) {
          for (const tab of state.tabs.values()) if (tab.windowId === state.tabs.get(id).windowId) tab.active = false;
          state.tabs.get(id).active = true;
          state.activations.push(id);
        }
      },
      async remove(ids) {
        for (const id of [].concat(ids)) {
          state.removed.push(id);
          state.tabs.delete(id);
        }
      },
      async ungroup(ids) {
        for (const id of [].concat(ids)) state.tabs.get(id).groupId = -1;
      },
      onCreated: {
        addListener(fn) {
          state.onCreated = fn;
        }
      }
    },
    tabGroups: {
      async get(id) {
        return { id, title: "Task - OBU" };
      },
      async query() {
        return [];
      },
      async update() {}
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand(target, method) {
        const { tabId } = target;
        state.sent.push(method);
        state.targets.push({ ...target, method });
        if (state.onSend) return await state.onSend(tabId, method);
        return { ok: method, active: state.tabs.get(tabId)?.active };
      },
      async getTargets() {
        return [];
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} }
    }
  };
  return { chrome: new Proxy(chrome, { get: (t, p) => (p in t ? t[p] : permissive()) }), state };
}

async function loadBackend() {
  const { chrome, state } = createChromeFake();
  const context = vm.createContext({
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, URL, TextEncoder, TextDecoder, structuredClone, crypto: globalThis.crypto, Date
  });
  vm.runInContext(
    "chrome.runtime.connectNative = () => ({ onMessage: { addListener(){} }, onDisconnect: { addListener(){} }, postMessage(){}, disconnect(){} });",
    context
  );
  const source = await readFile(BG_PATH, "utf8");
  vm.runInContext(`${source}\nglobalThis.BrowserBackend = BrowserBackend;`, context);
  const backend = new context.BrowserBackend();
  await backend.store.ready;
  backend.store.state.sessions = {
    s1: { chromeGroupId: 9, title: "Task - OBU", activeTabId: 1, tabOrigins: { 1: "agent", 2: "agent" } }
  };
  return { backend, state };
}

const cdp = (backend, tabId, method, extra = {}) =>
  backend.executeCdp({ session_id: "s1", turn_id: "t", target: { tabId }, method, commandParams: {}, ...extra });

async function run() {
  {
    const { backend, state } = await loadBackend();
    await cdp(backend, 1, "Runtime.evaluate");
    assert.ok(state.sent.includes("Page.enable"), "attach enables Page events");
    assert.ok(state.sent.includes("Emulation.setFocusEmulationEnabled"), "attach makes agent tabs act focused");
    backend.store.state.sessions.s1.tabOrigins[3] = "user";
    state.tabs.get(3).groupId = 9;
    state.sent.length = 0;
    await cdp(backend, 3, "Runtime.evaluate");
    assert.ok(!state.sent.includes("Emulation.setFocusEmulationEnabled"), "a tab claimed from the user keeps real focus state");
    backend.handleCdpEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "alert", message: "Hi there" });
    await assert.rejects(cdp(backend, 1, "Runtime.evaluate"), /blocked by a JavaScript alert dialog: "Hi there".*handleJavaScriptDialog/);
    await cdp(backend, 1, "Page.handleJavaScriptDialog");
    assert.deepEqual(await cdp(backend, 1, "Runtime.evaluate"), { ok: "Runtime.evaluate", active: false });
    console.log("test 1 ok: open dialog fails fast with a fix, and handling it clears the block");
  }
  {
    const { backend, state } = await loadBackend();
    state.tabs.set(6, { id: 6, groupId: 9, windowId: 1, openerTabId: 1, url: "https://spawned.test/" });
    state.slowGet = { 1: 30 }; // the opener lookup in recordSpawnedTab is slow
    state.onCreated(state.tabs.get(6));
    // No await between the tab appearing and the first command: the spawn
    // record must land before attach decides on focus emulation.
    await cdp(backend, 6, "Runtime.evaluate");
    assert.ok(state.sent.includes("Emulation.setFocusEmulationEnabled"), "a link-spawned tab gets focus emulation");
    // Two commands racing on a fresh spawned tab: the second must not run
    // before the first finished setting the tab up.
    state.tabs.set(7, { id: 7, groupId: 9, windowId: 1, openerTabId: 1, url: "https://spawned2.test/" });
    state.onCreated(state.tabs.get(7));
    state.targets.length = 0;
    const first = cdp(backend, 7, "Runtime.evaluate");
    await new Promise((resolve) => setTimeout(resolve, 10)); // first is mid-setup (spawn lookup takes 30ms)
    await Promise.all([first, cdp(backend, 7, "DOM.enable")]);
    const order = state.targets.filter((t) => t.tabId === 7).map((t) => t.method);
    assert.ok(
      order.indexOf("Emulation.setFocusEmulationEnabled") < order.indexOf("DOM.enable"),
      `setup runs before a parallel command: ${order.join(", ")}`
    );
    const tabs = await backend.getTabs({ session_id: "s1", turn_id: "t" });
    assert.equal(tabs.find((tab) => tab.id === 6)?.origin, "agent", "getTabs reports tab origin");
    console.log("test 1b ok: spawned tabs are known as agent tabs before first attach; getTabs reports origin");
  }
  {
    const { backend, state } = await loadBackend();
    await cdp(backend, 1, "Runtime.evaluate");
    state.onSend = (tabId, method) => {
      if (method !== "Input.dispatchMouseEvent") return {};
      backend.handleCdpEvent({ tabId }, "Page.javascriptDialogOpening", { type: "confirm", message: "Sure?" });
      return new Promise(() => {});
    };
    await assert.rejects(
      cdp(backend, 1, "Input.dispatchMouseEvent", { timeoutMs: 50 }),
      /confirm dialog: "Sure\?".*may already have run/
    );
    backend.handleCdpEvent({ tabId: 1 }, "Page.javascriptDialogClosed", {});
    state.onSend = null;
    await cdp(backend, 1, "Runtime.evaluate");
    console.log("test 2 ok: a command that opens a dialog reports the dialog, not a bare timeout");
  }
  {
    const { backend } = await loadBackend();
    await assert.rejects(cdp(backend, 2, "Runtime.evaluate"), /shows chrome:\/\/settings\/; Chrome does not let extensions control/);
    console.log("test 3 ok: chrome:// session tab gets a clear error");
  }
  {
    const { backend, state } = await loadBackend();
    state.tabs.set(4, { id: 4, groupId: 9, windowId: 1, openerTabId: 1, url: "https://popup.test/" });
    state.tabs.set(5, { id: 5, groupId: 9, windowId: 1, url: "https://dragged-in.test/" });
    await backend.recordSpawnedTab(state.tabs.get(4));
    await backend.finalizeTabs({ session_id: "s1", turn_id: "t", keep: [] });
    assert.deepEqual(state.removed.sort(), [1, 2, 4], "agent, chrome://, and link-spawned tabs close");
    assert.equal(state.tabs.get(5).groupId, -1, "a tab the user dragged in is only ungrouped");
    assert.equal(state.tabs.get(3).groupId, -1, "unrelated tab untouched");
    console.log("test 4 ok: finalize closes chrome:// and link-spawned tabs, releases unknown ones");
  }
  {
    const { backend, state } = await loadBackend();
    const result = await cdp(backend, 1, "Page.captureScreenshot");
    assert.equal(result.active, true, "tab is active while capturing");
    assert.deepEqual(state.activations, [1, 3], "switches to the tab, then back");
    assert.equal(state.tabs.get(3).active, true);
    state.activations.length = 0;
    state.tabs.get(1).active = true;
    state.tabs.get(3).active = false;
    await cdp(backend, 1, "Page.captureScreenshot");
    assert.deepEqual(state.activations, [], "an active tab is captured in place");
    console.log("test 5 ok: background tab screenshots switch to the tab and back");
  }
  {
    const { backend, state } = await loadBackend();
    await cdp(backend, 1, "Runtime.evaluate");
    assert.ok(
      state.targets.some((t) => t.method === "Target.setAutoAttach" && !t.sessionId),
      "attach turns on iframe auto-attach"
    );
    const frameInfo = { type: "iframe", targetId: "T1", url: "https://ads.example/frame", title: "" };
    backend.handleCdpEvent({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S1", targetInfo: frameInfo });
    backend.handleCdpEvent({ tabId: 1, sessionId: "S1" }, "Target.attachedToTarget", {
      sessionId: "S2",
      targetInfo: { type: "iframe", targetId: "T2", url: "https://pay.example/inner", title: "" }
    });
    backend.handleCdpEvent({ tabId: 1 }, "Target.attachedToTarget", {
      sessionId: "W1",
      targetInfo: { type: "worker", targetId: "TW", url: "https://a.test/w.js" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      state.targets.some((t) => t.sessionId === "S1" && t.method === "Target.setAutoAttach"),
      "nested iframes are auto-attached too"
    );
    const { frames } = JSON.parse(JSON.stringify(await backend.listFrames({ session_id: "s1", turn_id: "t", tabId: 1 })));
    assert.deepEqual(
      frames.map((f) => [f.type, f.sessionId, f.url]),
      [["page", null, "https://a.test/"], ["iframe", "S1", "https://ads.example/frame"], ["iframe", "S2", "https://pay.example/inner"]]
    );
    assert.equal(frames[2].parentSessionId, "S1");

    await cdp(backend, 1, "Runtime.evaluate", { target: { tabId: 1, frame: "pay.example" } });
    assert.deepEqual(state.targets.at(-1), { tabId: 1, sessionId: "S2", method: "Runtime.evaluate" });
    await cdp(backend, 1, "Runtime.evaluate", { target: { tabId: 1, frame: "S1" } });
    assert.equal(state.targets.at(-1).sessionId, "S1", "exact session id selects the frame");

    backend.handleCdpEvent({ tabId: 1 }, "Target.targetInfoChanged", { targetInfo: { targetId: "T1", url: "https://ads.example/next" } });
    await cdp(backend, 1, "Runtime.evaluate", { target: { tabId: 1, frame: "ads.example/next" } });
    assert.equal(state.targets.at(-1).sessionId, "S1", "frame URL follows navigation");

    backend.handleCdpEvent({ tabId: 1, sessionId: "S2" }, "Page.javascriptDialogOpening", { type: "alert", message: "from iframe" });
    await assert.rejects(cdp(backend, 1, "Runtime.evaluate"), /from iframe/);
    await cdp(backend, 1, "Page.handleJavaScriptDialog");
    assert.deepEqual(state.targets.at(-1), { tabId: 1, sessionId: "S2", method: "Page.handleJavaScriptDialog" },
      "an iframe's dialog is answered in its own session");

    backend.handleCdpEvent({ tabId: 1, sessionId: "S1" }, "Target.detachedFromTarget", { sessionId: "S2" });
    await assert.rejects(
      cdp(backend, 1, "Runtime.evaluate", { target: { tabId: 1, frame: "pay.example" } }),
      /No cross-origin iframe in tab 1 matches "pay.example". Iframes: https:\/\/ads.example\/next/
    );
    console.log("test 6 ok: cross-origin iframes are listed and targetable with --frame");
  }
  console.log("\nAll page access tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
