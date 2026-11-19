import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createCipheriv, createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Plugin from "../index.mjs";
import { accountHome, credentialSecret, decrypt, listAccounts, readAccount, resolveAccount, BASES } from "../accounts.mjs";

let home, dir, savedEnv, savedFetch, savedNow;
beforeEach(() => {
  savedEnv = { ...process.env }; savedFetch = globalThis.fetch; savedNow = Date.now;
  home = mkdtempSync(join(tmpdir(), "magpie-zsw-"));
  dir = join(home, ".zcode-switch", "accounts");
  cpSync(fileURLToPath(new URL("fixtures", import.meta.url)), dir, { recursive: true });
  process.env.ZCODE_SWITCH_HOME = home;
  process.env.ZCODE_CREDENTIAL_SECRET = "fixture-secret";
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
});
afterEach(() => {
  process.env = savedEnv; globalThis.fetch = savedFetch; Date.now = savedNow;
  rmSync(home, { recursive: true, force: true });
});
const write = (id, snapshot) => writeFileSync(join(dir, id + ".json"), JSON.stringify({ id, ...snapshot }));
const snapshot = () => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const host = async () => {
  const auth = {};
  const hooks = await Plugin({ client: { auth: { async set({ path, body }) { auth[path.id] = structuredClone(body); } } } });
  return { hooks, auth, async link(inputs) { return (await hooks.auth.methods[0].authorize(inputs)).callback(); } };
};

test("home and fallback derivation match Rust, including an empty override", () => {
  assert.equal(accountHome({ ZCODE_SWITCH_HOME: "/custom", HOME: "/home" }), "/custom");
  assert.equal(accountHome({ USERPROFILE: "/profile", HOME: "/home" }), "/profile");
  assert.equal(credentialSecret("/h", { USERNAME: "alice" }, "win32"), "zcode-credential-fallback:win32:/h:alice");
  assert.equal(credentialSecret("/h", { USER: "not-the-os-user" }, "linux"), `zcode-credential-fallback:linux:/h:${userInfo().username}`);
  assert.equal(credentialSecret("/h", { ZCODE_CREDENTIAL_SECRET: "" }), "");
});

test("known AES-GCM fixture decodes, and tampering/wrong secrets fail without leaking values", () => {
  const raw = JSON.parse(readFileSync(join(dir, "zai-account.json")));
  const encrypted = Object.values(raw.credentials).find((s) => s.startsWith("enc:"));
  assert.equal(decrypt(encrypted, "fixture-secret"), "fixture.paid-key");
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update("fixture-secret").digest(), Buffer.alloc(12, 7));
  const data = Buffer.concat([cipher.update("fixture.paid-key"), cipher.final()]);
  assert.equal(encrypted, "enc:v1:" + [Buffer.alloc(12, 7), cipher.getAuthTag(), data].map((x) => x.toString("base64url")).join("."));
  assert.throws(() => decrypt(encrypted, "wrong"), /Cannot decrypt/);
  assert.throws(() => decrypt("enc:v1:invalid", "fixture-secret"), /Cannot decrypt/);
  assert.throws(() => decrypt(encrypted.slice(0, -2), "fixture-secret"), /Cannot decrypt/);
});

test("selection shows name/email and persists only references in distinct stable slots", async () => {
  const before = snapshot();
  const { hooks, auth, link } = await host();
  assert.equal(hooks.auth.provider, "zcode-switch");
  const cfg = { provider: { zcode: { name: "Community ZCode" } } };
  await hooks.config(cfg);
  assert.equal(cfg.provider.zcode.name, "Community ZCode");
  assert.equal(cfg.provider["zcode-switch"].npm, "@ai-sdk/anthropic");
  assert.match(hooks.auth.methods[0].prompts[0].options.find((o) => o.value === "zai-account").label, /Example Z.ai.*example@example.invalid/);
  await link({ account: "+", ids: "zai-account,cn-account,zai-account" });
  await link({ account: "zai-account" });
  assert.equal(Object.keys(auth).length, 2);
  for (const [slot, body] of Object.entries(auth)) {
    assert.equal(slot, "zcode-switch#" + body.accountId);
    assert.deepEqual(JSON.parse(body.refresh), { accountId: body.accountId });
    assert.deepEqual(Object.keys(body).sort(), ["access", "accountId", "expires", "refresh", "type", "uid"]);
    assert.equal(body.access, "zcode-switch");
  }
  assert.doesNotMatch(JSON.stringify(auth), /fixture\.|example@example|enc:v1|eyJ/);
  await link({ account: "*" });
  assert.equal(Object.keys(auth).length, 3);
  assert.deepEqual(snapshot(), before);
});

test("missing, malformed, mismatched, unlinked, expired and empty accounts fail clearly", async () => {
  const { hooks, link } = await host();
  await assert.rejects(link({ account: "missing" }), /existing/);
  await assert.rejects(link({ account: "+", ids: "" }), /at least one/);
  await assert.rejects(hooks.auth.loader(async () => null), /Link a saved/);
  assert.throws(() => readAccount("../outside"), /Invalid/);
  assert.throws(() => readAccount("missing"), /missing or unreadable/);
  write("bad", { id: "other", credentials: {} });
  assert.throws(() => readAccount("bad"), /Invalid snapshot/);
  writeFileSync(join(dir, "bad.json"), "{");
  assert.throws(() => readAccount("bad"), /unreadable/);
  write("empty", { credentials: {} });
  assert.throws(() => resolveAccount("empty"), /no Coding Plan/);
  write("expired", { credentials: { zcodejwttoken: "e30.eyJleHAiOjF9.fixture" } });
  assert.throws(() => resolveAccount("expired"), /expired/);
  write("invalid", { credentials: { zcodejwttoken: "not-a-jwt" } });
  assert.throws(() => resolveAccount("invalid"), /invalid JWT/);
  write("located", { credentials: { "provider:coding-plan:api-key-location": "{}" } });
  assert.throws(() => resolveAccount("located"), /remote key location/);
  rmSync(dir, { recursive: true });
  assert.deepEqual(listAccounts(), []);
  await assert.rejects(link({ account: "*" }), /at least one/);
});

test("account symlinks are rejected", { skip: process.platform === "win32" }, () => {
  symlinkSync(join(dir, "cn-account.json"), join(dir, "linked.json"));
  assert.throws(() => readAccount("linked"), /unreadable/);
});

test("credential-map keys precede config keys, with Z.ai first within each source", () => {
  write("mixed", { credentials: {
    "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:cn:api-key": "cn.saved-key",
  }, config: { provider: { "builtin:zai-coding-plan": { options: { apiKey: "zai.config-key" } } } } });
  assert.equal(resolveAccount("mixed").site, "bigmodel");
  assert.equal(resolveAccount("mixed").key, "cn.saved-key");
  write("located", { credentials: { "project-key-location:v1:fixture": "{}" } });
  assert.throws(() => resolveAccount("located"), /remote key location/);
});

test("paid keys, config keys and JWTs route independently; fetch rereads snapshots", async () => {
  const before = snapshot();
  const { hooks, link } = await host();
  const auth = await link({ account: "zai-account" });
  auth.type = "oauth";
  const options = await hooks.auth.loader(async () => auth);
  assert.equal(options.baseURL, BASES.zai + "/v1");
  assert.equal(options.apiKey, "fixture.paid-key");
  assert.equal(resolveAccount("cn-account").base, BASES.bigmodel);
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init, body: await new Response(init.body).text() }); return new Response("ok"); };
  const controller = new AbortController();
  const send = () => options.fetch(BASES.zai + "/v1/messages?beta=true", { method: "POST", headers: { "x-api-key": "old", "anthropic-beta": "agent-beta", "x-magpie-work-dir": "private-directory", "proxy-authorization": "private-proxy", "content-type": "application/json" }, body: '{"model":"GLM-5.2"}', signal: controller.signal });
  await send();
  assert.equal(calls[0].init.headers.get("x-api-key"), "fixture.paid-key");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer fixture.paid-key");
  assert.equal(calls[0].init.headers.get("x-magpie-work-dir"), null);
  assert.equal(calls[0].init.headers.get("proxy-authorization"), null);
  write("zai-account", { ...JSON.parse(before["cn-account.json"]), id: "zai-account" });
  await send();
  assert.equal(calls[1].url, BASES.bigmodel + "/v1/messages?beta=true");
  assert.equal(calls[1].init.headers.get("x-api-key"), "fixture.cn-key");
  write("zai-account", { ...JSON.parse(before["jwt-account.json"]), id: "zai-account" });
  await send();
  assert.equal(calls[2].url, BASES.session + "/v1/messages");
  assert.match(calls[2].init.headers.get("Authorization"), /^Bearer eyJ/);
  assert.equal(calls[2].init.headers.get("x-api-key"), null);
  assert.equal(calls[2].init.headers.get("anthropic-beta"), null);
  assert.equal(calls[2].init.headers.get("X-ZCode-App-Version"), "3.17.2");
  assert.equal(calls[2].init.redirect, "error");
  assert.equal(calls[2].body, '{"model":"GLM-5.2"}');
  controller.abort();
  assert.equal(calls[2].init.signal.aborted, true);
  await assert.rejects(options.fetch("https://evil.invalid/v1/messages"), /unknown inference/);
  await assert.rejects(options.fetch(BASES.zai + "/v1/event/report"), /Unsupported/);
  rmSync(join(dir, "zai-account.json"));
  await assert.rejects(send(), /missing/);
  assert.equal(calls.length, 3);
});

test("models use plan-specific config rules, safe fallback and cache without credentials", async () => {
  const { hooks, link } = await host();
  const auth = await link({ account: "zai-account" }); auth.type = "oauth";
  const fallback = await hooks.provider.models({}, { auth });
  assert.ok(fallback["GLM-5.3"]);
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true);
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(init.headers, undefined);
    if (String(url).includes("client/configs")) return Response.json({ data: { configs: { builtin_provider_config_json: "https://cdn.example.invalid/models.json" } } });
    return Response.json({ config: {
      providerConfigRules: { providerRules: [
        { providerId: "account:zai-individual-coding-plan", builtinModelIds: ["GLM-Test", "Disabled"] },
        { providerId: "account:bigmodel-individual-coding-plan", builtinModelIds: ["CN-Model"] },
        { providerId: "account:zai-start-plan", builtinModelIds: ["Session-Model"] },
      ] },
      modelConfigRules: { builtinProviderModelRules: [{ providerId: "account:zai-individual-coding-plan", modelId: "Disabled", config: { enabled: false } }], modelRules: [{ modelMatch: "GLM-.*", config: { properties: { contextWindow: 12345 } } }] },
    } });
  };
  const models = await hooks.provider.models({}, { auth });
  assert.deepEqual(Object.keys(models), ["GLM-Test"]);
  assert.equal(models["GLM-Test"].limit.context, 12345);
  for (const [id, expected] of [["cn-account", "CN-Model"], ["jwt-account", "Session-Model"]]) {
    const selected = await link({ account: id }); selected.type = "oauth";
    assert.deepEqual(Object.keys(await hooks.provider.models({}, { auth: selected })), [expected]);
  }
  assert.equal(calls, 2);
  const now = Date.now(); Date.now = () => now + 600_001;
  globalThis.fetch = async () => Response.json({ data: { configs: { builtin_provider_config_json: "http://insecure.invalid" } } });
  const jwt = await link({ account: "jwt-account" }); jwt.type = "oauth";
  assert.equal((await hooks.provider.models({}, { auth: jwt }))["GLM-5.3"], undefined);
});
