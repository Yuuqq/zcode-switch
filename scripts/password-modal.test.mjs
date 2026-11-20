import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function harness(invoke) {
  const nodes = new Map();
  function node() {
    return {
      value: "", textContent: "", disabled: false, removed: false, events: {},
      addEventListener(event, handler) { this.events[event] = handler; },
      remove() { this.removed = true; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      querySelector(selector) {
        if (selector === "#pw2") return null;
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
      },
      querySelectorAll(selector) { return [this.querySelector(selector)]; },
    };
  }
  let mask;
  const done = [];
  const context = vm.createContext({
    document: {
      addEventListener() {}, querySelector: () => null,
      createElement: () => { mask = node(); return mask; },
      body: { appendChild() {} },
    },
    invoke, t: (key) => key, ic: () => "", errCode: () => null, stripErr: String,
  });
  vm.runInContext(source, context);
  context.openPwModal({ mode: "import", files: [["accounts.zsb", {}]], onDone: (report) => done.push(report) });
  const input = nodes.get("#pw1"), go = nodes.get(".pw-go"), error = nodes.get(".pw-err");
  return { mask, input, go, error, done, submit: () => go.events.click() };
}

for (const error of [
  "accounts.zsb: wrong_password:Wrong password or corrupted file",
  "账号.zsb：wrong_password:密码错误或文件已损坏",
  "wrong_password:Wrong password or corrupted file",
]) {
  test(`wrong password stays open and allows retry: ${error}`, async () => {
    let attempts = 0;
    const h = harness(async (command, args) => {
      assert.equal(command, "import_sealed");
      attempts++;
      if (attempts === 1) return { added: [], skipped: [], errors: [error] };
      assert.equal(args.password, "correct");
      return { added: ["Account"], skipped: [], errors: [] };
    });
    h.input.value = "wrong";
    await h.submit();
    assert.equal(h.mask.removed, false);
    assert.equal(h.error.textContent, "pw.errWrong");
    assert.equal(h.go.disabled, false);
    assert.equal(h.input.selected, true);
    assert.equal(h.done.length, 0);
    h.input.value = "correct";
    await h.submit();
    assert.equal(h.mask.removed, true);
    assert.equal(h.error.textContent, "");
    assert.equal(h.done.length, 1);
    assert.equal(attempts, 2);
  });
}

test("blank passwords do not submit and non-password report errors retain existing completion behavior", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { errors: ["accounts.zsb: unsupported_version:Unsupported version"] }; });
  await h.submit();
  assert.equal(h.error.textContent, "pw.errEmpty");
  assert.equal(calls, 0);
  assert.equal(h.mask.removed, false);
  h.input.value = "password";
  await h.submit();
  assert.equal(h.mask.removed, true);
  assert.equal(h.done.length, 1);
});

test("thrown import errors keep the dialog open and retryable", async () => {
  const h = harness(async () => { throw "wrong_password:Wrong password"; });
  h.input.value = "password";
  await h.submit();
  assert.equal(h.mask.removed, false);
  assert.equal(h.go.disabled, false);
  assert.match(h.error.textContent, /Wrong password/);
});

test("duplicate confirmation while an import is pending does not submit twice", async () => {
  let release, calls = 0;
  const h = harness(() => { calls++; return new Promise((resolve) => { release = resolve; }); });
  h.input.value = "password";
  const pending = h.submit();
  await h.submit();
  assert.equal(calls, 1);
  release({ errors: ["accounts.zsb: wrong_password:Wrong password"] });
  await pending;
  assert.equal(h.mask.removed, false);
  assert.equal(h.go.disabled, false);
});
