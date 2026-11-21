import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function harness(invoke, mode = "exportAll") {
  const nodes = new Map(), toasts = [], done = [], masks = [], keys = new Set(), copied = [];
  function node() {
    return {
      value: "password", type: "password", textContent: "", disabled: false, removed: false, events: {}, style: {},
      setAttribute() {}, select() {},
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
      addEventListener: (event, callback) => { if (event === "keydown") keys.add(callback); },
      removeEventListener: (_, callback) => keys.delete(callback), querySelector: () => null,
      createElement: () => { mask = node(); masks.push(mask); return mask; },
      body: { appendChild() {} },
    },
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
    invoke, t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    ic: () => "", stripErr: String,
  });
  vm.runInContext(source, context);
  context.recordToast = (...args) => toasts.push(args);
  vm.runInContext("toast = recordToast;", context);
  context.openPwModal({ mode, name: "Account", id: "account", count: 3, path: "/fake/accounts.zsb", onDone: (report) => done.push(report) });
  return { mask, masks, nodes, keys, copied, context, toasts, done, error: nodes.get(".pw-err"), go: nodes.get(".pw-go"), submit: () => nodes.get(".pw-go").events.click() };
}

test("export-all with skips opens a persistent escaped report and copies only plain-text metadata", async () => {
  const skipped = [{ name: "Foreign credentials", reason: "Cannot decrypt /credentials/token" }, { name: "Foreign config", reason: "Cannot decrypt /config/key" }];
  const h = harness(async (command, args) => {
    assert.equal(command, "export_all_finalize");
    assert.equal(args.password, "password");
    return { count: 1, path: args.path, skipped };
  });
  await h.submit();
  assert.equal(h.toasts.length, 0);
  assert.equal(h.masks.length, 2);
  const report = h.masks[1];
  assert.equal(report.className, "export-report-mask");
  assert.equal(report.removed, false);
  assert.match(report.innerHTML, /report.count/);
  assert.match(report.innerHTML, /accounts.zsb/);
  await h.nodes.get(".export-report-copy").events.click();
  const detail = h.copied[0];
  for (const s of skipped) {
    assert.ok(detail.includes(s.name));
    assert.ok(detail.includes(s.reason));
  }
  assert.ok(detail.includes("/fake/accounts.zsb"));
  assert.equal(h.mask.removed, true);
  assert.equal(h.done.length, 1);
  assert.equal(report.removed, false);
  h.nodes.get(".export-report-close").events.click();
  assert.equal(report.removed, true);
});

test("report escapes account names, reasons and path; copying excludes unexpected secret fields", async () => {
  const h = harness(async () => ({ count: 1, path: '/fake/<path>.zsb', password: "DO_NOT_COPY", credentials: { token: "DO_NOT_COPY" }, skipped: [{ name: '<img src=x onerror="bad">', reason: '<script>bad</script>&details', token: "DO_NOT_COPY" }] }));
  await h.submit();
  const report = h.masks[1];
  assert.doesNotMatch(report.innerHTML, /<img|<script>|<path>|DO_NOT_COPY/);
  assert.match(report.innerHTML, /&lt;img/);
  assert.match(report.innerHTML, /&lt;script&gt;/);
  await h.nodes.get(".export-report-copy").events.click();
  assert.match(h.copied[0], /<img/);
  assert.match(h.copied[0], /<script>/);
  assert.doesNotMatch(h.copied[0], /DO_NOT_COPY|&lt;/);
});

test("copy failure leaves the report open and retryable; Escape closes it", async () => {
  const h = harness(async () => ({ count: 1, path: "/fake/a.zsb", skipped: [{ name: "Account", reason: "Cannot decrypt /config/key" }] }));
  await h.submit();
  h.context.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  const copy = h.nodes.get(".export-report-copy");
  await copy.events.click();
  assert.equal(copy.disabled, false);
  assert.equal(h.nodes.get(".export-report-status").textContent, "report.copyFailed");
  assert.equal(h.masks[1].removed, false);
  for (const key of [...h.keys]) key({ key: "Escape" });
  assert.equal(h.masks[1].removed, true);
});

for (const supported of [true, false]) {
  test(`report copy without Clipboard API ${supported ? "uses fallback" : "reports failure"} and remains open`, async () => {
    const h = harness(async () => ({ count: 1, path: "/fake/a.zsb", skipped: [{ name: "Account", reason: "Cannot decrypt /config/key" }] }));
    await h.submit();
    h.context.navigator.clipboard = undefined;
    h.context.document.execCommand = (command) => { assert.equal(command, "copy"); return supported; };
    await h.nodes.get(".export-report-copy").events.click();
    assert.equal(h.nodes.get(".export-report-status").textContent, supported ? "report.copied" : "report.copyFailed");
    assert.equal(h.masks[1].removed, false);
    assert.equal(h.masks[2].removed, true);
    assert.match(h.masks[2].value, /Account: Cannot decrypt \/config\/key/);
  });
}

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
