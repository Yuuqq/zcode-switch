import { createDecipheriv, createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const validId = (id) => typeof id === "string" && /^[A-Za-z0-9-]+$/.test(id);

export function accountHome(env = process.env) {
  return env.ZCODE_SWITCH_HOME ?? env.USERPROFILE ?? env.HOME ?? homedir();
}

export function credentialSecret(home, env = process.env, platform = process.platform) {
  if (env.ZCODE_CREDENTIAL_SECRET !== undefined) return env.ZCODE_CREDENTIAL_SECRET;
  let primary;
  if (platform === "win32") primary = env.USERNAME;
  else {
    try { primary = userInfo().username; } catch { primary = env.USER; }
  }
  return `zcode-credential-fallback:${platform}:${home}:${primary ?? env.USER ?? env.LOGNAME ?? "unknown"}`;
}

export function decrypt(value, secret) {
  if (typeof value === "string" && value.startsWith("enc:v1:")) {
    try {
      const parts = value.slice(7).split(".");
      if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new Error();
      const [nonce, tag, data] = parts.map((p) => Buffer.from(p, "base64url"));
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), nonce);
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
    } catch {
      throw new Error("Cannot decrypt saved credentials: check ZCODE_CREDENTIAL_SECRET and the source machine/home/user");
    }
  }
  if (Array.isArray(value)) return value.map((v) => decrypt(v, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decrypt(v, secret)]));
  return value;
}

export function readAccount(id) {
  if (!validId(id)) throw new Error("Invalid ZCode Switch account id");
  const home = accountHome();
  const file = join(home, ".zcode-switch", "accounts", `${id}.json`);
  let account;
  try {
    if (!lstatSync(file).isFile()) throw new Error();
    account = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Saved account ${id} is missing or unreadable; restore it in ZCode Switch`);
  }
  if (account?.id !== id || !account.credentials || typeof account.credentials !== "object" || Array.isArray(account.credentials)) {
    throw new Error(`Invalid snapshot for saved account ${id}`);
  }
  const secret = credentialSecret(home);
  return { ...account, credentials: decrypt(account.credentials, secret), config: decrypt(account.config, secret) };
}

export function listAccounts() {
  const dir = join(accountHome(), ".zcode-switch", "accounts");
  let files;
  try { files = readdirSync(dir); } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error("Cannot read the ZCode Switch account library");
  }
  return files.filter((f) => f.endsWith(".json") && validId(f.slice(0, -5))).sort().map((file) => {
    const id = file.slice(0, -5);
    try {
      const account = readAccount(id);
      const c = account.credentials;
      let info = {};
      try { info = JSON.parse(c[`oauth:${c["oauth:active_provider"] || "zai"}:user_info`] || "{}"); } catch {}
      const email = info.email || info.rawProfile?.email || "";
      return { id, label: [account.name || id, email, `(${id})`].filter(Boolean).join(" — ") };
    } catch (e) {
      return { id, label: `${id} — ${e.message}` };
    }
  });
}

const text = (v) => typeof v === "string" ? v.trim() : "";
const planKey = (v) => text(v).includes(".") && !/[\s{$]/.test(text(v)) && !text(v).startsWith("project-key-location:") ? text(v) : "";
export const BASES = {
  zai: "https://api.z.ai/api/anthropic",
  bigmodel: "https://open.bigmodel.cn/api/anthropic",
  session: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
};

export function resolveAccount(id) {
  const account = readAccount(id);
  const c = account.credentials;
  let key = "", site = c["oauth:active_provider"] === "bigmodel" ? "bigmodel" : "zai";
  for (const family of ["zai", "bigmodel"]) {
    for (const [name, value] of Object.entries(c)) {
      if (name.includes(":coding-plan:") && name.includes(`:${family}-`) && name.endsWith(":api-key") && planKey(value)) {
        key = planKey(value); site = family; break;
      }
    }
    if (key) break;
  }
  if (!key) {
    for (const family of ["zai", "bigmodel"]) {
      for (const provider of [`builtin:${family}-coding-plan`, `account:${family}-individual-coding-plan`]) {
        key = planKey(account.config?.provider?.[provider]?.options?.apiKey);
        if (key) { site = family; break; }
      }
      if (key) break;
    }
  }
  if (key) return { id, site, key, base: BASES[site], session: false };
  if (Object.keys(c).some((k) => k.startsWith("project-key-location:v1:") || /:api-key-location$/.test(k))) {
    throw new Error(`Account ${id} stores a remote key location, not an API key; save its resolved Coding Plan key before linking`);
  }
  const jwt = text(c.zcodejwttoken).replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Error(`Account ${id} has no Coding Plan API key or ZCode JWT session; update its snapshot`);
  let payload;
  try {
    if (jwt.split(".").length !== 3) throw new Error();
    payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= 0) throw new Error();
  } catch { throw new Error(`Account ${id} has an invalid JWT session; sign in again and update its snapshot`); }
  if (Number(payload.exp) * 1000 <= Date.now()) throw new Error(`Account ${id} session expired; sign in again and update its ZCode Switch snapshot`);
  return { id, site, key: jwt, base: BASES.session, session: true };
}
