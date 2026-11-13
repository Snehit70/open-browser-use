// Node test for the popup's agent kill switches (endSession, releaseTab) and
// the session snapshot it renders. Run: node apps/chrome-extension/popup-actions.test.mjs
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
      [1, { id: 1, groupId: 9, title: "A", url: "https://a.test/" }],
      [2, { id: 2, groupId: 9, title: "B", url: "https://b.test/" }],
      [3, { id: 3, groupId: -1, title: "C", url: "https://c.test/" }],
      [4, { id: 4, groupId: 5, title: "Done", url: "https://d.test/", windowId: 1 }]
    ]),
    groups: new Map([
      [9, { id: 9, title: "Task - OBU", windowId: 1 }],
      [5, { id: 5, title: "✅ Open Browser Use", windowId: 1 }]
    ]),
    detached: []
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
        if (!state.tabs.has(id)) throw new Error("No tab");
        return { ...state.tabs.get(id) };
      },
      async query({ groupId }) {
        return [...state.tabs.values()].filter((tab) => tab.groupId === groupId).map((tab) => ({ ...tab }));
      },
      async ungroup(ids) {
        for (const id of [].concat(ids)) state.tabs.get(id).groupId = -1;
      }
    },
    tabGroups: {
      async get(id) {
        if (![...state.tabs.values()].some((tab) => tab.groupId === id) || !state.groups.has(id)) {
          throw new Error("No group");
        }
        return state.groups.get(id);
      },
      async query({ title }) {
        return [...state.groups.values()].filter((group) => group.title === title);
      },
      async update() {}
    },
    debugger: {
      async detach({ tabId }) {
        state.detached.push(tabId);
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
    s1: { chromeGroupId: 9, title: "Task - OBU", activeTabId: 1, tabOrigins: { 1: "agent", 2: "user" } }
  };
  backend.attachedTabs.add(1);
  return { backend, state };
}

async function run() {
  {
    const { backend } = await loadBackend();
    const snapshot = JSON.parse(JSON.stringify(await backend.popupState()));
    assert.equal(snapshot.sessions.length, 1);
    assert.deepEqual(
      snapshot.sessions[0].tabs.map((tab) => [tab.id, tab.controlled, tab.agentActive]),
      [[1, true, true], [2, false, false]]
    );
    assert.deepEqual(snapshot.results.map((tab) => tab.id), [4], "finished tabs show as results");
    assert.equal(snapshot.sessions[0].lastActivity, null);
    await backend.requireSession({ session_id: "s1", turn_id: "t" });
    const after = await backend.popupState();
    assert.ok(Date.now() - after.sessions[0].lastActivity < 1000, "agent calls update lastActivity");
    console.log("test 1 ok: popupState lists sessions, results, and agent activity");
  }
  {
    const { backend, state } = await loadBackend();
    await backend.releaseTab(1);
    assert.deepEqual(state.detached, [1]);
    assert.equal(state.tabs.get(1).groupId, -1);
    assert.equal(state.tabs.get(2).groupId, 9, "other tabs stay in the task");
    assert.ok(!backend.attachedTabs.has(1));
    assert.ok(!("1" in backend.store.state.sessions.s1.tabOrigins));
    console.log("test 2 ok: releaseTab detaches and ungroups only that tab");
  }
  {
    const { backend, state } = await loadBackend();
    await backend.releaseTab(3);
    assert.equal(state.tabs.get(3).groupId, -1);
    assert.ok(backend.store.state.sessions.s1, "unrelated tab leaves sessions alone");
    console.log("test 3 ok: releaseTab on a user tab is harmless");
  }
  {
    const { backend, state } = await loadBackend();
    await backend.endSession("s1");
    assert.deepEqual(state.detached.sort(), [1, 2]);
    assert.equal(state.tabs.get(1).groupId, -1);
    assert.equal(state.tabs.get(2).groupId, -1);
    assert.equal(backend.store.state.sessions.s1, undefined);
    assert.equal((await backend.popupState()).sessions.length, 0);
    console.log("test 4 ok: endSession detaches, ungroups, and forgets the session");
  }
  console.log("\nAll popup action tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
