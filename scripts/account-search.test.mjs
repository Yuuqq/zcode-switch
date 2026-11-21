import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { bindAccountSearch, filterAccounts } from "../src/account-search.js";

const accounts = [
  { id: "a", name: "工作账号", is_active: true, jwt_expired: true, identity: { username: "Alice", email: "Alice@Example.com", user_id: "user-42", provider: "bigmodel" } },
  { id: "b", name: "Travel", identity: { display_name: "Bob", provider: "zai" } },
  { id: "c", name: "Old snapshot" },
];

test("search matches names, identity, platform aliases, case and CJK without mutating accounts", () => {
  for (const query of ["工作", "ALICE", "EXAMPLE.COM", "USER-42", "BigModel", "智谱", "alice 工作"]) {
    assert.deepEqual(filterAccounts(accounts, query).map((a) => a.id), ["a"], query);
  }
  for (const query of ["BOB", "z.ai", "ZAI", "ＺＡＩ", "国际站"]) {
    assert.deepEqual(filterAccounts(accounts, query).map((a) => a.id), ["b"], query);
  }
  assert.equal(filterAccounts(accounts, "alice")[0], accounts[0]);
  assert.equal(accounts[0].is_active, true);
  assert.equal(accounts[0].jwt_expired, true);
  assert.equal(accounts.length, 3);
  assert.equal(filterAccounts([{ name: "Legacy", platform: "Custom" }], "CUSTOM").length, 1);
});

test("blank search preserves all accounts; unmatched/missing identity and empty libraries are safe", () => {
  for (const query of ["", " \t ", null]) assert.equal(filterAccounts(accounts, query), accounts);
  assert.deepEqual(filterAccounts(accounts, "no such identity"), []);
  assert.deepEqual(filterAccounts([], "anything"), []);
  assert.deepEqual(filterAccounts([{}], "anything"), []);
});

function inputNode() {
  const handlers = {};
  return {
    value: "", selectionStart: 0, selectionEnd: 0,
    addEventListener: (name, callback) => { handlers[name] = callback; },
    emit(name, props = {}) {
      const event = { preventDefault() {}, stopPropagation() {}, ...props };
      handlers[name]?.(event);
    },
  };
}

test("search input commits CJK composition only when complete; Escape clears outside composition", () => {
  const input = inputNode(), changes = [], composition = [];
  bindAccountSearch(input, (value) => changes.push(value), (value) => composition.push(value));
  input.emit("compositionstart");
  input.value = "工作";
  input.emit("input", { isComposing: true });
  input.emit("keydown", { key: "Escape", isComposing: true });
  assert.deepEqual(changes, []);
  input.emit("compositionend");
  assert.deepEqual(changes, ["工作"]);
  assert.deepEqual(composition, [true, false]);
  input.emit("keydown", { key: "Escape" });
  assert.equal(input.value, "");
  assert.deepEqual(changes, ["工作", ""]);
});

test("main render retains the query, focus, active/error badges, counts and empty-result state", async () => {
  const document = { activeElement: null };
  let input = null, html = "";
  const app = {
    querySelector: (selector) => selector === ".account-search" ? input : null,
    set innerHTML(value) {
      html = value;
      input = inputNode();
      input.value = value.match(/class="account-search"[^>]*value="([^"]*)"/)?.[1] || "";
      input.focus = () => { document.activeElement = input; };
      input.setSelectionRange = (start, end) => { input.selectionStart = start; input.selectionEnd = end; };
    },
  };
  document.getElementById = () => app;
  const context = vm.createContext({
    document, window: {}, filterAccounts, bindAccountSearch,
    installDelegation() {}, listen: async () => {}, ic: () => "", esc: (s) => String(s ?? ""),
    t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    invoke: async () => ({ accounts, language: "en" }), init() {},
  });
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").split("\n(async () => {")[0];
  vm.runInContext(`${source}
    state = { accounts: ${JSON.stringify(accounts)} };
    acctQuota.a = { err: 'quota offline' };
    globalThis.api = { render, refresh };
    render();
  `, context);
  input.focus();
  input.value = "ALICE";
  input.selectionStart = input.selectionEnd = 3;
  input.emit("input");
  assert.match(html, /row active/);
  assert.match(html, /tag-relogin/);
  assert.match(html, /aq-err/);
  assert.match(html, /m.searchCount:\{"shown":1,"total":3\}/);
  assert.match(html, /m.searchBatchScope:\{"count":3\}/);
  assert.doesNotMatch(html, /data-id="b"/);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 3);
  await context.api.refresh();
  context.api.render();
  assert.equal(input.value, "ALICE");
  assert.doesNotMatch(html, /data-id="b"/);
  input.emit("compositionstart");
  const composingInput = input;
  context.api.render();
  assert.equal(input, composingInput);
  input.value = "不存在";
  input.emit("compositionend");
  assert.match(html, /m.searchEmpty/);
  input.emit("keydown", { key: "Escape" });
  assert.match(html, /data-id="b"/);
  assert.equal(input.value, "");
});
