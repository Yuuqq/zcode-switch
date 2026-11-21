import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function harness(invoke, mode = "import") {
  const nodes = new Map();
  function node() {
    return {
      value: "", type: "password", textContent: "", disabled: false, removed: false, events: {}, attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(event, handler) { this.events[event] = handler; },
      remove() { this.removed = true; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      querySelector(selector) {
        if (selector === "#pw2" && mode === "import") return null;
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
  context.openPwModal({ mode, name: "Account", path: "/fake/accounts.zsb", files: [["accounts.zsb", {}]], onDone: (report) => done.push(report) });
  const input = nodes.get("#pw1"), go = nodes.get(".pw-go"), error = nodes.get(".pw-err");
  return { mask, input, go, error, done, nodes, context, submit: () => go.events.click() };
}

for (const closeBy of ["escape", "backdrop", "replacement"]) {
  test(`password visibility resets when closing by ${closeBy}`, () => {
    const h = harness(async () => {});
    h.input.value = "temporary secret";
    h.nodes.get("#pw1-toggle").events.click();
    if (closeBy === "escape") h.mask.events.keydown({ key: "Escape" });
    if (closeBy === "backdrop") h.mask.events.click();
    if (closeBy === "replacement") h.context.openPwModal({ mode: "import", files: [["next.zsb", {}]] });
    assert.equal(h.mask.removed, true);
    assert.equal(h.input.type, "password");
    assert.equal(h.input.value, "");
  });
}

for (const mode of ["import", "export", "exportAll"]) {
  test(`${mode} password fields have accessible visibility controls and autocomplete hints`, () => {
    let calls = 0;
    const h = harness(async () => { calls++; }, mode);
    const fields = mode === "import" ? ["pw1"] : ["pw1", "pw2"];
    for (const id of fields) {
      const input = h.nodes.get(`#${id}`), toggle = h.nodes.get(`#${id}-toggle`);
      assert.match(h.mask.innerHTML, new RegExp(`id="${id}"[^>]*autocomplete="${mode === "import" ? "current-password" : "new-password"}"[^>]*spellcheck="false" autocapitalize="off"`));
      assert.match(h.mask.innerHTML, new RegExp(`type="button"[^>]*id="${id}-toggle"[^>]*aria-controls="${id}"[^>]*aria-pressed="false"`));
      input.value = "keep password";
      toggle.events.click();
      assert.equal(input.type, "text");
      assert.equal(toggle.attrs["aria-pressed"], "true");
      assert.equal(toggle.attrs["aria-label"], "pw.hidePassword");
      assert.equal(input.value, "keep password");
      toggle.events.click();
      assert.equal(input.type, "password");
      assert.equal(toggle.attrs["aria-pressed"], "false");
      toggle.events.click();
    }
    assert.match(h.mask.innerHTML, /name="username" autocomplete="username" value="accounts.zsb"/);
    assert.equal(calls, 0);
    h.nodes.get(".pw-cancel").events.click();
    for (const id of fields) {
      assert.equal(h.nodes.get(`#${id}`).type, "password");
      assert.equal(h.nodes.get(`#${id}`).value, "");
      assert.equal(h.nodes.get(`#${id}-toggle`).attrs["aria-pressed"], "false");
    }
    assert.equal(h.mask.removed, true);
  });
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
