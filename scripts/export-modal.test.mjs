import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function harness(invoke, mode = "exportAll") {
  const nodes = new Map(), toasts = [], done = [];
  function node() {
    return {
      value: "password", textContent: "", disabled: false, removed: false, events: {},
      addEventListener(event, handler) { this.events[event] = handler; },
      remove() { this.removed = true; },
      focus() {},
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
      },
      querySelectorAll(selector) { return [this.querySelector(selector)]; },
    };
  }
  let mask;
  const context = vm.createContext({
    document: {
      addEventListener() {}, querySelector: () => null,
      createElement: () => { mask = node(); return mask; },
      body: { appendChild() {} },
    },
    invoke, t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    ic: () => "", stripErr: String,
  });
  vm.runInContext(source, context);
  context.recordToast = (...args) => toasts.push(args);
  vm.runInContext("toast = recordToast;", context);
  context.openPwModal({ mode, name: "Account", id: "account", count: 3, path: "/fake/accounts.zsb", onDone: (report) => done.push(report) });
  return { mask, toasts, done, error: nodes.get(".pw-err"), go: nodes.get(".pw-go"), submit: () => nodes.get(".pw-go").events.click() };
}

test("export-all with skips shows a warning listing names and reasons, not green success", async () => {
  const skipped = [{ name: "Foreign credentials", reason: "Cannot decrypt /credentials/token" }, { name: "Foreign config", reason: "Cannot decrypt /config/key" }];
  const h = harness(async (command, args) => {
    assert.equal(command, "export_all_finalize");
    assert.equal(args.password, "password");
    return { count: 1, path: args.path, skipped };
  });
  await h.submit();
  assert.equal(h.toasts.length, 1);
  const [message, kind, detail] = h.toasts[0];
  assert.equal(message, 'pw.exportedAllSkipped:{"count":1,"skipped":2}');
  assert.equal(kind, "warn");
  for (const s of skipped) {
    assert.ok(detail.includes(s.name));
    assert.ok(detail.includes(s.reason));
  }
  assert.ok(detail.includes("/fake/accounts.zsb"));
  assert.equal(h.mask.removed, true);
  assert.equal(h.done.length, 1);
});

test("export-all without skips keeps the successful export toast", async () => {
  const h = harness(async () => ({ count: 3, path: "/fake/accounts.zsb", skipped: [] }));
  await h.submit();
  assert.equal(h.toasts[0][0], 'pw.exportedAllToast:{"count":3}');
  assert.equal(h.toasts[0][1], "ok");
  assert.equal(h.mask.removed, true);
});

for (const mode of ["export", "exportAll"]) {
  test(`${mode} failure stays visible with no successful completion or toast`, async () => {
    const h = harness(async () => { throw "Cannot export account Foreign: /config/key. Use original ZCODE_CREDENTIAL_SECRET."; }, mode);
    await h.submit();
    assert.match(h.error.textContent, /Foreign.*config\/key.*ZCODE_CREDENTIAL_SECRET/);
    assert.equal(h.mask.removed, false);
    assert.equal(h.go.disabled, false);
    assert.equal(h.toasts.length, 0);
    assert.equal(h.done.length, 0);
  });
}
