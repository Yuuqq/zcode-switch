import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/settings-diagnostics.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key;

function views() {
  const context = vm.createContext({ esc, t });
  vm.runInContext(source, context);
  return context;
}

test("connectivity view separates login/backend, classified errors, latency and direct fallback", () => {
  const view = views();
  assert.equal(view.connectivityHtml(null), "");
  const html = view.connectivityHtml({ proxy: "http://localhost:8080", targets: [
    { group: "login", url: "https://bigmodel.cn/", primary: { ok: false, category: "proxy_auth", status: 407, latency_ms: 12 }, direct: { ok: true, category: "ok", status: 200, latency_ms: 30 } },
    { group: "backend", url: "https://zcode.z.ai/<test>", primary: { ok: false, category: "dns", latency_ms: 100 }, direct: null },
  ] });
  assert.match(html, /diag.login/);
  assert.match(html, /diag.backend/);
  assert.match(html, /diag.proxyAuth/);
  assert.match(html, /HTTP 407/);
  assert.match(html, /diag.ok/);
  assert.match(html, /&quot;ms&quot;:30/);
  assert.match(html, /diag.dns/);
  assert.match(html, /&lt;test&gt;/);
  assert.doesNotMatch(html, /<test>/);
});

test("Magpie view renders read-only counts, sanitized paths, yes/no environment and copyable steps", () => {
  const view = views();
  const data = {
    library_path: '/home/<unsafe>/.zcode-switch/accounts', library_readable: false,
    counts: { total: 7, readable: 5, usable: 3, unreadable: 2, no_credentials: 1, expired: 1 },
    cli_found: false, config_path: "/home/user/.config/magpie", config_exists: true,
    secret_set: true, secret: "NEVER_RENDER_SECRET", credentials: "NEVER_RENDER_SECRET",
    node_version: "v19.0.0", node_supported: false,
  };
  const html = view.magpieHtml(data, "1.7.0-beta.3");
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /diag.libraryError/);
  assert.match(html, /&quot;usable&quot;:3/);
  assert.match(html, /ZCODE_CREDENTIAL_SECRET<\/dt><dd>diag.yes/);
  assert.match(html, /v19.0.0/);
  assert.match(html, /diag.nodeSupported/);
  assert.match(html, /zcode-switch-magpie-plugin-v1.7.0-beta.3.zip/);
  assert.match(html, /magpie plugin add \/absolute\/path\/zcode-switch-magpie-plugin/);
  assert.match(html, /readonly/);
  assert.doesNotMatch(html, /NEVER_RENDER_SECRET|<unsafe>/);
  assert.match(view.magpieHtml(null, ""), /releases\/latest/);
  assert.match(view.magpieHtml({ ...data, counts: { total: 0 }, node_version: null }, ""), /diag.notFound/);
});

function settingsHarness(invoke) {
  const proxy = { value: "http://localhost:9999" }, copied = [], toasts = [];
  const field = { focus() {}, select() { this.selected = true; } };
  const app = { innerHTML: "" };
  const view = views();
  const context = vm.createContext({
    document: { getElementById: () => app, querySelector: (selector) => selector === ".magpie-install" ? field : proxy },
    window: {}, esc, t, invoke, toast: (...args) => toasts.push(args),
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
    connectivityHtml: view.connectivityHtml, magpieHtml: view.magpieHtml, releaseUrl: view.releaseUrl, installSteps: view.installSteps,
    listen() {}, installDelegation() {}, ic: () => "", lang: () => "en",
  });
  const settingsSource = readFileSync(new URL("../src/settings.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").split("\n(async () => {")[0];
  vm.runInContext(`${settingsSource}
    state = { accounts: [], language: 'en', auth_proxy_url: 'http://saved:8080', auth_proxy_on: false, zcode_path: '' };
    appVer = '1.7.0-beta.3';
    globalThis.api = { actions, render };
  `, context);
  return { context, api: context.api, proxy, copied, toasts, field, app };
}

test("connection test uses unsaved input even when disabled, never saves, and hides raw errors", async () => {
  const calls = [];
  const h = settingsHarness(async (command, args) => {
    calls.push([command, args]);
    throw new Error("proxy user:DO_NOT_DISPLAY");
  });
  await h.api.actions.testProxy();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "test_proxy_connection");
  assert.equal(calls[0][1].proxy, "http://localhost:9999");
  assert.match(h.app.innerHTML, /diag.failed/);
  assert.match(h.app.innerHTML, /auth-proxy" type="password"/);
  assert.doesNotMatch(h.app.innerHTML, /DO_NOT_DISPLAY/);
  h.proxy.value = "";
  await h.api.actions.testProxy();
  assert.equal(calls[1][1].proxy, null);
});

test("Magpie commands only read diagnostics and copy instructions; copy denial is recoverable", async () => {
  const calls = [];
  const h = settingsHarness(async (command) => { calls.push(command); throw new Error("DO_NOT_DISPLAY"); });
  await h.api.actions.magpieDiagnostics();
  assert.deepEqual(calls, ["get_magpie_diagnostics"]);
  assert.match(h.app.innerHTML, /diag.failed/);
  assert.doesNotMatch(h.app.innerHTML, /DO_NOT_DISPLAY/);
  await h.api.actions.copyMagpieSteps();
  assert.match(h.copied[0], /releases\/download\/v1.7.0-beta.3/);
  assert.match(h.copied[0], /magpie plugin add/);
  h.context.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  await h.api.actions.copyMagpieSteps();
  assert.equal(h.field.selected, true);
  assert.equal(h.toasts.at(-1)[0], "diag.copyError");
});

test("only one test runs at a time and successful results preserve the unsaved proxy draft", async () => {
  let finish, calls = 0;
  const h = settingsHarness(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const pending = h.api.actions.testProxy();
  await h.api.actions.testProxy();
  assert.equal(calls, 1);
  assert.match(h.app.innerHTML, /diag.testing/);
  h.proxy.value = "http://new-draft:1234";
  finish({ proxy: "http://localhost:9999", targets: [] });
  await pending;
  assert.match(h.app.innerHTML, /http:\/\/new-draft:1234/);
  assert.match(h.app.innerHTML, /diag.route/);
  assert.doesNotMatch(h.app.innerHTML, /diag.testing|diag.failed/);
});
