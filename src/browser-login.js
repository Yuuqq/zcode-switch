import { esc, toast } from "./ui.js";
import { t, stripErr } from "./i18n.js";

let active = null;
const completed = new Set();

export function closeBrowserLogin(flow) {
  if (flow) {
    completed.add(flow);
    if (completed.size > 32) completed.delete(completed.values().next().value);
  }
  if (!active || (flow && active.flow !== flow)) return;
  active.close();
  active = null;
}

export function openBrowserLogin(login, provider, { invoke, clipboard = navigator.clipboard }) {
  closeBrowserLogin();
  if (completed.has(login.flow)) return;
  const mask = document.createElement("div");
  mask.className = "pw-mask";
  mask.innerHTML = `<div class="pw-panel" role="dialog" aria-modal="true" aria-labelledby="browser-login-title">
    <div class="pw-title" id="browser-login-title">${t("m.browserWaiting")}</div>
    <div class="pw-sub">${esc(t("m.browserProvider", { provider }))}</div>
    <div class="pw-sub browser-countdown"></div>
    <div class="pw-sub">${t("m.browserHint")}</div>
    <div class="pw-err" role="alert"></div>
    <div class="pw-actions">
      <button class="btn-ghost browser-reopen">${t("m.browserReopen")}</button>
      <button class="btn-ghost browser-copy">${t("m.browserCopy")}</button>
      <button class="btn-primary browser-cancel">${t("common.cancel")}</button>
    </div>
  </div>`;
  const error = mask.querySelector(".pw-err");
  const cancel = mask.querySelector(".browser-cancel");
  const reopen = mask.querySelector(".browser-reopen");
  const copy = mask.querySelector(".browser-copy");
  let cancelling = false;
  const run = async (fn) => {
    error.textContent = "";
    try { await fn(); } catch (e) { error.textContent = stripErr(e); }
  };
  const stop = async () => {
    if (cancelling) return;
    cancelling = true;
    cancel.disabled = true;
    try {
      await invoke("oauth_cancel", { flow: login.flow });
      closeBrowserLogin(login.flow);
    } catch (e) {
      error.textContent = stripErr(e);
      cancelling = false;
      cancel.disabled = false;
    }
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); stop(); } };
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((login.expires_at_ms - Date.now()) / 1000));
    mask.querySelector(".browser-countdown").textContent = t("m.browserExpiry", { seconds });
    if (!seconds) {
      error.textContent = t("m.browserExpired");
      reopen.disabled = copy.disabled = true;
    }
  };
  reopen.addEventListener("click", () => run(() => invoke("open_external", { url: login.url })));
  copy.addEventListener("click", () => run(async () => {
    let copied = false;
    if (clipboard?.writeText) {
      try { await clipboard.writeText(login.url); copied = true; } catch {}
    }
    if (!copied) {
      const input = document.createElement("textarea");
      input.value = login.url;
      input.style.position = "fixed";
      input.style.opacity = "0";
      mask.appendChild(input);
      input.select();
      try { copied = document.execCommand?.("copy") || false; } finally { input.remove(); cancel.focus(); }
    }
    if (!copied) throw new Error(t("m.browserCopyFailed"));
    toast(t("m.browserCopied"));
  }));
  cancel.addEventListener("click", stop);
  document.addEventListener("keydown", onKey);
  const timer = setInterval(tick, 1000);
  active = { flow: login.flow, close() {
    clearInterval(timer);
    document.removeEventListener("keydown", onKey);
    mask.remove();
  } };
  document.body.appendChild(mask);
  tick();
  cancel.focus();
}
