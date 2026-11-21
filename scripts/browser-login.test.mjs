import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/browser-login.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function harness(invoke = async () => {}) {
  const masks = [], timers = new Map(), listeners = new Map(), copied = [], toasts = [];
  let now = 1000, timer = 0;
  const context = vm.createContext({
    document: {
      createElement(tag) {
        if (tag === "textarea") return { style: {}, select() {}, remove() {} };
        const nodes = new Map();
        const mask = { removed: false, appendChild() {}, remove() { this.removed = true; }, querySelector(selector) {
          if (!nodes.has(selector)) nodes.set(selector, { textContent: "", disabled: false, focus() {}, addEventListener(event, fn) { this[event] = fn; } });
          return nodes.get(selector);
        } };
        masks.push(mask);
        return mask;
      },
      body: { appendChild() {} },
      execCommand: () => false,
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event); },
    },
    t: (key, args) => args ? `${key}:${JSON.stringify(args)}` : key,
    esc: (s) => s.replaceAll("<", "&lt;"), stripErr: String,
    toast: (...args) => toasts.push(args),
    Date: { now: () => now },
    setInterval: (fn) => { timers.set(++timer, fn); return timer; },
    clearInterval: (id) => timers.delete(id),
  });
  vm.runInContext(source, context);
  const login = { flow: "one", url: "https://example.invalid/login?state=test", expires_at_ms: 5000 };
  return {
    context, masks, timers, listeners, copied, toasts, login,
    open(value = login, clipboard = { writeText: async (url) => copied.push(url) }) { context.openBrowserLogin(value, "<Provider>", { invoke, clipboard }); return masks.at(-1); },
    tick(time) { now = time; for (const fn of timers.values()) fn(); },
  };
}

test("browser modal displays provider/expiry, reopens/copies link, and cancels its flow", async () => {
  const calls = [];
  const h = harness(async (...args) => calls.push(args));
  const mask = h.open();
  assert.match(mask.innerHTML, /&lt;Provider>/);
  assert.match(mask.querySelector(".browser-countdown").textContent, /"seconds":4/);
  await mask.querySelector(".browser-reopen").click();
  assert.equal(calls[0][0], "open_external");
  assert.equal(calls[0][1].url, h.login.url);
  await mask.querySelector(".browser-copy").click();
  assert.deepEqual(h.copied, [h.login.url]);
  await mask.querySelector(".browser-cancel").click();
  assert.equal(calls[1][0], "oauth_cancel");
  assert.equal(calls[1][1].flow, "one");
  assert.equal(mask.removed, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
});

test("completion before begin returns does not reopen a finished modal; stale results leave new flow alone", () => {
  const h = harness();
  h.context.closeBrowserLogin("one");
  h.open();
  assert.equal(h.masks.length, 0);
  const mask = h.open({ ...h.login, flow: "two" });
  h.context.closeBrowserLogin("one");
  assert.equal(mask.removed, false);
  h.context.closeBrowserLogin("two");
  assert.equal(mask.removed, true);
  assert.equal(h.timers.size, 0);
});

test("expiry is explicit and disables reopening/copying; completion cleans up", () => {
  const h = harness();
  const mask = h.open();
  h.tick(6000);
  assert.match(mask.querySelector(".browser-countdown").textContent, /"seconds":0/);
  assert.equal(mask.querySelector(".pw-err").textContent, "m.browserExpired");
  assert.equal(mask.querySelector(".browser-reopen").disabled, true);
  assert.equal(mask.querySelector(".browser-copy").disabled, true);
  h.context.closeBrowserLogin("one");
  assert.equal(mask.removed, true);
});

test("opener and cancellation errors stay visible and cancellation can be retried", async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error("offline"); });
  const mask = h.open();
  await mask.querySelector(".browser-reopen").click();
  assert.match(mask.querySelector(".pw-err").textContent, /offline/);
  await mask.querySelector(".browser-cancel").click();
  assert.equal(mask.removed, false);
  assert.equal(mask.querySelector(".browser-cancel").disabled, false);
  fail = false;
  await mask.querySelector(".browser-cancel").click();
  assert.equal(mask.removed, true);
});

test("copy supports webviews without Clipboard API and reports failure without closing", async () => {
  const h = harness();
  const mask = h.open(h.login, {});
  await mask.querySelector(".browser-copy").click();
  assert.match(mask.querySelector(".pw-err").textContent, /m.browserCopyFailed/);
  assert.equal(mask.removed, false);
  h.context.document.execCommand = (command) => command === "copy";
  await mask.querySelector(".browser-copy").click();
  assert.equal(h.toasts.length, 1);
  assert.equal(mask.querySelector(".pw-err").textContent, "");
  h.context.closeBrowserLogin("one");
});
