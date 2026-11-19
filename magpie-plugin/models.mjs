const FALLBACK = [
  { id: "GLM-5.3", context: 1_000_000, output: 128_000 },
  { id: "GLM-5.3-Flash", context: 1_000_000, output: 128_000 },
  { id: "GLM-5.2", context: 1_000_000, output: 128_000 },
  { id: "GLM-5-Turbo", context: 200_000, output: 64_000 },
];
export const VERSION = "3.17.2";
let cache;

function entry(m, base) {
  return {
    id: m.id, name: m.id, reasoning: true, tool_call: true, attachment: !!m.image,
    modalities: { input: m.image ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: m.context || 0, output: m.output || 0 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ...(base ? { api: { id: m.id, url: base + "/v1", npm: "@ai-sdk/anthropic" } } : {}),
  };
}

export function fallbackModels(session = false, base) {
  return Object.fromEntries(FALLBACK.filter((m) => !session || m.id !== "GLM-5.3").map((m) => [m.id, entry(m, base)]));
}

export async function accountModels(state) {
  let cfg;
  try {
    if (cache && Date.now() - cache.at < 600_000) cfg = cache.cfg;
    else {
      const res = await fetch(`https://zcode.z.ai/api/v1/client/configs?app_version=${VERSION}&platform=${process.platform}-${process.arch}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error();
      const envelope = await res.json();
      const url = (envelope.data ?? envelope)?.configs?.builtin_provider_config_json;
      if (typeof url !== "string" || new URL(url).protocol !== "https:") throw new Error();
      const models = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!models.ok) throw new Error();
      cfg = await models.json();
      cache = { cfg, at: Date.now() };
    }
  } catch {
    const out = fallbackModels(state.session, state.base);
    out[Symbol.for("magpie.fellBack")] = true;
    return out;
  }
  const plan = state.session ? "account:zai-start-plan" : `account:${state.site}-individual-coding-plan`;
  const c = cfg?.config ?? {};
  const ids = new Set();
  for (const r of c.providerConfigRules?.providerRules ?? []) {
    if (r.providerId === plan) for (const id of r.builtinModelIds ?? []) if (typeof id === "string") ids.add(id);
  }
  const off = new Set();
  for (const r of c.modelConfigRules?.builtinProviderModelRules ?? []) {
    if (r.providerId !== plan || typeof r.modelId !== "string") continue;
    if (r.config?.enabled === false) off.add(r.modelId.toLowerCase());
    else ids.add(r.modelId);
  }
  const out = {};
  for (const id of ids) {
    if (off.has(id.toLowerCase())) continue;
    const m = { id };
    for (const r of c.modelConfigRules?.modelRules ?? []) {
      let matches;
      try { matches = new RegExp(`^(?:${r.modelMatch})$`, "i").test(id); } catch { continue; }
      if (!matches) continue;
      m.context = r.config?.properties?.contextWindow ?? m.context;
      m.output = r.config?.optionSpecs?.maxOutputTokens?.max ?? m.output;
      m.image = r.config?.properties?.inputFormat?.supportsImage ?? m.image;
    }
    out[id] = entry(m, state.base);
  }
  if (Object.keys(out).length) return out;
  const fallback = fallbackModels(state.session, state.base);
  fallback[Symbol.for("magpie.fellBack")] = true;
  return fallback;
}
