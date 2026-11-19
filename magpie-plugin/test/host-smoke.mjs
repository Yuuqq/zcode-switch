import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const host = process.argv[2];
if (!host) throw new Error("Usage: node test/host-smoke.mjs /path/to/magpie/internal/plugin/host.js (bun must be on PATH)");
const root = mkdtempSync(join(tmpdir(), "magpie-zsw-host-"));
const home = join(root, "home");
cpSync(fileURLToPath(new URL("fixtures", import.meta.url)), join(home, ".zcode-switch", "accounts"), { recursive: true });
const authPath = join(root, "plugin-auth.json");
const pending = new Map();
let sequence = 0, stderr = "";
const child = spawn(process.env.BUN || "bun", [resolve(host)], {
  env: { ...process.env, ZCODE_SWITCH_HOME: home, ZCODE_CREDENTIAL_SECRET: "fixture-secret" },
  stdio: ["pipe", "pipe", "pipe"],
});
const fail = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
child.on("error", fail);
child.on("exit", (code) => fail(new Error(`Host exited (${code}): ${stderr}`)));
child.stderr.on("data", (data) => { stderr += data; });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { fail(new Error("Non-JSON host output")); return; }
  const p = pending.get(msg.id);
  if (!p || msg.event) return;
  clearTimeout(p.timer); pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  const target = fileURLToPath(new URL("..", import.meta.url));
  const init = await rpc("init", { authPath, directory: root, plugins: [{ spec: target, target }] });
  assert.equal(init.plugins.length, 1);
  assert.equal(init.plugins[0].error, undefined);
  const p = { provider: "zcode-switch", method: 0 };
  const prompt = await rpc("prompt", p);
  assert.ok(prompt.prompt.options.some((o) => /example@example.invalid/.test(o.label)));
  for (let i = 0; i < 2; i++) {
    const start = await rpc("authorize", { ...p, inputs: { account: "*" } });
    assert.equal(start.ok, true);
    assert.equal((await rpc("callback", { session: start.session })).ok, true);
    const saved = JSON.parse(readFileSync(authPath));
    assert.equal(Object.keys(saved).length, 3);
    assert.doesNotMatch(JSON.stringify(saved), /fixture\.|enc:v1|eyJ|example@example/);
    for (const [slot, auth] of Object.entries(saved)) {
      assert.equal(slot, "zcode-switch#" + auth.accountId);
      assert.deepEqual(JSON.parse(auth.refresh), { accountId: auth.accountId });
    }
  }
  for (const [id, base] of [["zai-account", "https://api.z.ai/api/anthropic/v1"], ["cn-account", "https://open.bigmodel.cn/api/anthropic/v1"], ["jwt-account", "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1"]]) {
    const loaded = await rpc("load", { provider: "zcode-switch", account: "zcode-switch#" + id });
    assert.equal(loaded.baseURL, base);
    assert.equal(loaded.fetch, true);
  }
  console.log("Magpie Bun host smoke: PASS (load, prompts, multi-account sign-in, deduplication, reference-only storage, three credential routes)");
} finally {
  child.kill(); lines.close();
  rmSync(root, { recursive: true, force: true });
}
