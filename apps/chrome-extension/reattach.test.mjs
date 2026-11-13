// Node test for debugger re-attach in executeCdp.
// Run: node apps/chrome-extension/reattach.test.mjs
//
// Chrome can drop a tab's debugger on navigation/reload, and the MV3 service
// worker forgets attachedTabs when it restarts. executeCdp must re-attach on
// demand instead of failing with "Debugger unattached", retry once when Chrome
// says the debugger is not attached, and never retry a command that may already
// have run ("Detached while handling command").

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BG_PATH = path.join(HERE, "background.js");

// Any chrome.* namespace not defined below resolves to a permissive stub whose
// event objects accept listeners and whose methods resolve to undefined.
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

function createChromeFake() {
  const state = {
    attached: new Set(),
    attachCalls: 0,
    sent: [],
    // Queue of errors to throw from the next sendCommand calls.
    sendErrors: [],
    storage: {}
  };
  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return key in state.storage ? { [key]: state.storage[key] } : {};
          return { ...state.storage };
        },
        async set(obj) {
          Object.assign(state.storage, obj);
        }
      }
    },
    debugger: {
      async attach({ tabId }) {
        state.attachCalls++;
        if (state.attached.has(tabId)) {
          throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
        }
        state.attached.add(tabId);
      },
      async detach({ tabId }) {
        state.attached.delete(tabId);
      },
      async sendCommand({ tabId }, method) {
        state.sent.push(method);
        const queued = state.sendErrors.shift();
        if (queued) throw new Error(queued);
        if (!state.attached.has(tabId)) {
          throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        }
        return { ok: method };
      },
      async getTargets() {
        return [];
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} }
    }
  };
  return {
    chrome: new Proxy(chrome, { get: (target, prop) => (prop in target ? target[prop] : permissive()) }),
    state
  };
}

async function loadBackend() {
  const { chrome, state } = createChromeFake();
  const context = vm.createContext({
    chrome,
    console,
    setTimeout,
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
  // Session membership is covered elsewhere; isolate the attach logic.
  backend.requireSession = async () => ({ sessionId: "s" });
  backend.requireSessionTab = async () => {};
  return { backend, state };
}

const cdp = (backend, tabId, method = "Runtime.evaluate") =>
  backend.executeCdp({ session_id: "s", turn_id: "t", target: { tabId }, method, commandParams: {} });

async function run() {
  // 1. Tab never attached (or worker restarted): executeCdp attaches on demand.
  {
    const { backend, state } = await loadBackend();
    const result = await cdp(backend, 7);
    assert.deepEqual(result, { ok: "Runtime.evaluate" });
    assert.ok(state.attached.has(7), "tab must be attached on demand");
    console.log("test 1 ok: attaches on demand instead of 'Debugger unattached'");
  }

  // 2. Chrome dropped the debugger (navigation) without onDetach reaching us:
  //    retry once after re-attaching.
  {
    const { backend, state } = await loadBackend();
    await cdp(backend, 7);
    state.attached.delete(7); // Chrome-side detach; backend still thinks attached
    const result = await cdp(backend, 7, "Page.captureScreenshot");
    assert.deepEqual(result, { ok: "Page.captureScreenshot" });
    // Re-attaching also re-enables Page events (for dialog detection).
    assert.deepEqual(
      state.sent.filter((method) => method !== "Page.enable").slice(-2),
      ["Page.captureScreenshot", "Page.captureScreenshot"]
    );
    console.log("test 2 ok: re-attaches and retries once after Chrome detached");
  }

  // 3. Our attachment survived a worker restart: "Another debugger" is treated
  //    as attached and the command goes through.
  {
    const { backend, state } = await loadBackend();
    state.attached.add(7);
    const result = await cdp(backend, 7);
    assert.deepEqual(result, { ok: "Runtime.evaluate" });
    console.log("test 3 ok: stale attachment after worker restart is reused");
  }

  // 4. A command that may have run is not retried.
  {
    const { backend, state } = await loadBackend();
    await cdp(backend, 7);
    state.sendErrors.push("Detached while handling command.");
    const sentBefore = state.sent.length;
    await assert.rejects(cdp(backend, 7, "Input.dispatchMouseEvent"), /Detached while handling command/);
    assert.equal(state.sent.length - sentBefore, 1, "possibly-executed command must not be retried");
    console.log("test 4 ok: does not retry 'Detached while handling command'");
  }

  console.log("\nAll re-attach tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
