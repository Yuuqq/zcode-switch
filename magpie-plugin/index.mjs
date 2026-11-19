import { release } from "node:os";
import { BASES, listAccounts, resolveAccount } from "./accounts.mjs";
import { accountModels, fallbackModels, VERSION } from "./models.mjs";

const PROVIDER = "zcode-switch";
const reference = (id) => ({ type: "oauth", access: PROVIDER, refresh: JSON.stringify({ accountId: id }), expires: 0, accountId: id, uid: id });

function source(auth) {
  let id;
  try { id = JSON.parse(auth?.refresh).accountId; } catch {}
  if (auth?.type !== "oauth" || typeof id !== "string") throw new Error("Link a saved ZCode Switch account first");
  return resolveAccount(id);
}

function headersFor(state, incoming) {
  const h = state.session ? new Headers() : new Headers(incoming);
  h.delete("x-api-key");
  h.delete("authorization");
  h.delete("host");
  h.delete("content-length");
  h.delete("proxy-authorization");
  h.delete("cookie");
  for (const name of [...h.keys()]) if (name.startsWith("x-magpie-")) h.delete(name);
  h.set("Authorization", `Bearer ${state.key}`);
  if (!state.session) h.set("x-api-key", state.key);
  else {
    h.set("content-type", new Headers(incoming).get("content-type") || "application/json");
    h.set("anthropic-version", "2023-06-01");
    h.set("HTTP-Referer", "https://zcode.z.ai");
    h.set("User-Agent", `ZCode/${VERSION} ai-sdk/anthropic/3.0.81`);
    h.set("X-ZCode-App-Version", VERSION);
    h.set("X-Title", "Z Code@electron");
    h.set("X-Release-Channel", "production");
    const locale = Intl.DateTimeFormat().resolvedOptions();
    h.set("X-Client-Language", locale.locale);
    h.set("X-Client-Timezone", locale.timeZone);
    h.set("X-ZCode-Agent", "glm");
    h.set("X-Platform", `${process.platform}-${process.arch}`);
    h.set("X-Os-Category", process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
    h.set("X-Os-Version", release());
  }
  return h;
}

export default async function ZCodeSwitchPlugin({ client }) {
  const accounts = listAccounts();
  return {
    async config(cfg) {
      cfg.provider ??= {};
      const old = cfg.provider[PROVIDER] || {};
      cfg.provider[PROVIDER] = { ...old, name: "ZCode Switch", npm: "@ai-sdk/anthropic", api: BASES.zai + "/v1", models: { ...fallbackModels(), ...old.models } };
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        return accountModels(source(auth));
      },
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 3,
      methods: [{
        type: "oauth",
        label: "Link saved ZCode Switch accounts / 关联已保存账号",
        prompts: [
          { type: "select", key: "account", message: "Choose saved accounts / 选择账号", options: [
            ...accounts.map((a) => ({ value: a.id, label: a.label })),
            { value: "*", label: "All saved accounts / 全部账号" },
            { value: "+", label: "Selected account IDs / 多选账号 ID" },
          ] },
          { type: "text", key: "ids", message: "Account IDs, comma separated / 账号 ID，以逗号分隔", condition: (inputs) => inputs.account === "+" },
        ],
        async authorize(inputs = {}) {
          const available = listAccounts();
          const ids = [...new Set(inputs.account === "*" ? available.map((a) => a.id) : inputs.account === "+" ? String(inputs.ids || "").split(",").map((s) => s.trim()).filter(Boolean) : [inputs.account])];
          if (!ids.length || ids.some((id) => !available.some((a) => a.id === id))) throw new Error("Choose at least one existing ZCode Switch account; reload plugins after adding accounts");
          ids.forEach(resolveAccount);
          return {
            url: "", method: "auto", instructions: "Linking local references only; no credentials are copied / 仅关联本地引用，不复制凭据",
            async callback() {
              ids.forEach(resolveAccount);
              for (const id of ids) {
                await client.auth.set({ path: { id: `${PROVIDER}#${id}` }, body: reference(id) });
              }
              return { ...reference(ids[0]), type: "success" };
            },
          };
        },
      }],
      async loader(getAuth) {
        const first = source(await getAuth());
        return {
          baseURL: first.base + "/v1", apiKey: first.session ? "zcode" : first.key,
          headers: Object.fromEntries(headersFor(first)),
          async fetch(input, init) {
            const state = source(await getAuth());
            const url = new URL(input instanceof Request ? input.url : String(input));
            const bases = Object.values(BASES);
            const old = bases.find((base) => url.href.startsWith(base + "/"));
            if (!old) throw new Error("Refusing to send saved credentials to an unknown inference endpoint");
            const suffix = state.session ? url.href.slice(old.length).split("?")[0] : url.href.slice(old.length);
            if (!/^\/v1\/(messages|complete)(\/count_tokens)?(?:\?|$)/.test(suffix)) throw new Error("Unsupported ZCode inference path");
            const request = new Request(input, init);
            return fetch(state.base + suffix, {
              method: request.method, headers: headersFor(state, request.headers),
              body: request.body, signal: request.signal, duplex: "half", redirect: "error",
            });
          },
        };
      },
    },
  };
}
