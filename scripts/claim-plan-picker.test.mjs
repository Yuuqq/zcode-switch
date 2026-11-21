import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function harness() {
  const masks = [], keys = new Set();
  const document = {
    activeElement: null,
    addEventListener: (_, handler) => keys.add(handler),
    removeEventListener: (_, handler) => keys.delete(handler),
    body: { appendChild: (mask) => masks.push(mask) },
    createElement() {
      const node = () => ({
        handlers: {},
        addEventListener(name, callback) { this.handlers[name] = callback; },
        focus() { document.activeElement = this; },
        click() { this.handlers.click?.({ target: this }); },
      });
      const mask = node();
      mask.cancel = node();
      Object.defineProperty(mask, "innerHTML", {
        set(html) { mask.html = html; mask.choices = [...html.matchAll(/data-index="\d+"/g)].map(node); },
      });
      mask.querySelectorAll = () => mask.choices;
      mask.querySelector = () => mask.cancel;
      mask.remove = () => masks.splice(masks.indexOf(mask), 1);
      return mask;
    },
  };
  const context = vm.createContext({
    document,
    esc: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
  });
  const source = readFileSync(new URL("../src/claim-plan-picker.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export function", "function");
  vm.runInContext(`${source}\nglobalThis.pick = pickClaimPlan;`, context);
  return {
    pick: (plans) => context.pick(plans, { accountName: "Account", describePlan: (plan) => (plan.grants || []).join(" · ") }),
    masks, keys, document,
    key(key, shiftKey = false) { for (const handler of keys) handler({ key, shiftKey, preventDefault() {} }); },
  };
}

const plans = [
  { plan_id: "one", name: "First", grants: ["10M tokens"], description: "Weekly" },
  { plan_id: "two", name: "Second", grants: ["20M tokens"], description: "Monthly" },
];

test("zero plans cancels and one plan claims directly, without a picker", async () => {
  const h = harness();
  assert.equal(await h.pick([]), null);
  assert.equal(await h.pick([plans[0]]), "one");
  assert.equal(h.masks.length, 0);
  assert.equal(h.keys.size, 0);
});

test("multiple plans display eligibility details and return the selected plan ID", async () => {
  const h = harness();
  const pending = h.pick(plans);
  assert.match(h.masks[0].html, /First/);
  assert.match(h.masks[0].html, /20M tokens/);
  assert.match(h.masks[0].html, /Monthly/);
  assert.equal(h.document.activeElement, h.masks[0].choices[0]);
  h.masks[0].choices[1].click();
  assert.equal(await pending, "two");
  assert.equal(h.masks.length, 0);
  assert.equal(h.keys.size, 0);
});

for (const method of ["button", "escape", "backdrop"]) {
  test(`picker ${method} cancellation returns no plan and cleans up`, async () => {
    const h = harness();
    const pending = h.pick(plans);
    if (method === "button") h.masks[0].cancel.click();
    if (method === "escape") h.key("Escape");
    if (method === "backdrop") h.masks[0].click();
    assert.equal(await pending, null);
    assert.equal(h.masks.length, 0);
    assert.equal(h.keys.size, 0);
  });
}

test("picker traps keyboard focus and safely escapes server-supplied text", async () => {
  const h = harness();
  const pending = h.pick([{ ...plans[0], name: '<img src=x onerror="bad">' }, plans[1]]);
  const mask = h.masks[0];
  assert.doesNotMatch(mask.html, /<img/);
  assert.match(mask.html, /&lt;img/);
  h.key("Tab", true);
  assert.equal(h.document.activeElement, mask.cancel);
  h.key("Tab");
  assert.equal(h.document.activeElement, mask.choices[0]);
  h.key("Escape");
  await pending;
});

test("opening a replacement picker resolves the old picker as cancelled", async () => {
  const h = harness();
  const old = h.pick(plans);
  const current = h.pick(plans);
  assert.equal(await old, null);
  assert.equal(h.masks.length, 1);
  h.masks[0].cancel.click();
  await current;
});
