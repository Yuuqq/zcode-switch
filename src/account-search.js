const normalize = (value) => String(value ?? "").normalize("NFKC").toLowerCase();

export function filterAccounts(accounts, query) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return accounts;
  return accounts.filter((account) => {
    const identity = account.identity || {};
    const provider = normalize(identity.provider || account.provider || account.platform);
    const aliases = provider === "bigmodel" ? "BigModel 智谱 智谱开放平台"
      : ["zai", "z.ai"].includes(provider) ? "z.ai zai 国际站" : "";
    const text = normalize([
      account.name, identity.username, identity.display_name, identity.email, identity.user_id,
      identity.provider, account.provider, account.platform, aliases,
    ].filter((value) => value != null).join(" "));
    return terms.every((term) => text.includes(term));
  });
}

export function bindAccountSearch(input, onChange, onComposition) {
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; onComposition(true); });
  input.addEventListener("compositionend", () => {
    composing = false;
    onComposition(false);
    onChange(input.value);
  });
  input.addEventListener("input", (event) => {
    if (!composing && !event.isComposing) onChange(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || composing || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    input.value = "";
    onChange("");
  });
}
