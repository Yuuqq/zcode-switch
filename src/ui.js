import { invoke } from "@tauri-apps/api/core";
import { ic } from "./icons.js";
import { t, has, stripErr } from "./i18n.js";

document.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("keydown", (e) => {
  if (e.key === "F12") e.preventDefault();
  if (e.ctrlKey && e.shiftKey && ["I", "i", "J", "j", "C", "c"].includes(e.key)) e.preventDefault();
  if (e.ctrlKey && ["u", "s"].includes(e.key.toLowerCase())) e.preventDefault();
});

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function dismissSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 220);
}

export function toast(msg, kind = "ok", detail = "") {
  let zone = document.querySelector(".toast-zone");
  if (!zone) {
    zone = document.createElement("div");
    zone.className = "toast-zone";
    document.body.appendChild(zone);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = `<span class="t-ic">${ic(kind === "ok" ? "check" : "alert", 16)}</span>
    <span class="t-body">${esc(msg)}${detail ? `<span class="detail">${esc(detail)}</span>` : ""}</span>`;
  zone.appendChild(t);
  setTimeout(() => t.remove(), detail ? 5200 : 3200);
}

function runAttr(expr, event) {
  try {
    const open = expr.indexOf("(");
    if (open < 0 || !expr.trimEnd().endsWith(")")) return;
    let fn = window;
    for (const seg of expr.slice(0, open).trim().split(".")) fn = fn?.[seg];
    if (typeof fn !== "function") return;
    const src = expr.slice(open + 1, expr.trimEnd().length - 1).trim();
    const args = src
      ? src.split(/\s*,\s*/).map((a) => {
          if (a === "event") return event;
          const m = a.match(/^'([^']*)'$/);
          if (m) return m[1];
          return JSON.parse(a);
        })
      : [];
    fn(...args);
  } catch (e) {
    console.warn("attr handler error:", expr, e);
  }
}

export function installDelegation() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[click]");
    if (!el) return;
    e.preventDefault();
    runAttr(el.getAttribute("click") || "", e);
  });
  document.addEventListener("keydown", (e) => {
    const el = e.target.closest("[keydown]");
    if (!el) return;
    runAttr(el.getAttribute("keydown") || "", e);
  });
  document.addEventListener("blur", (e) => {
    const el = e.target.closest("[blur]");
    if (!el) return;
    runAttr(el.getAttribute("blur") || "", e);
  }, true);
}

export function openConfirmModal(m) {
  document.querySelector(".cm-mask")?.remove();
  const kind = m.kind || "plain";
  const mask = document.createElement("div");
  mask.className = "cm-mask";
  mask.innerHTML = `
    <div class="cm-panel" role="alertdialog" aria-modal="true" aria-label="${esc(m.title)}">
      <div class="cm-strip ${kind}"></div>
      <div class="cm-head">
        <span class="cm-ic ${kind}">${ic(m.icon || "alert", 21)}</span>
        <div class="cm-title">${esc(m.title)}</div>
      </div>
      ${m.desc ? `<div class="cm-desc">${m.desc}</div>` : ""}
      <div class="cm-actions">
        <button class="btn-ghost cm-no">${esc(m.noLabel || t("common.cancel"))}</button>
        <button class="cm-yes ${kind}">${esc(m.yesLabel || t("common.confirm"))}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const panel = mask.querySelector(".cm-panel");
  const yes = mask.querySelector(".cm-yes");
  const no = mask.querySelector(".cm-no");
  const close = () => {
    document.removeEventListener("keydown", mask._key);
    mask.remove();
  };
  panel.addEventListener("click", (e) => e.stopPropagation());
  mask.addEventListener("click", close);
  no.addEventListener("click", close);
  yes.addEventListener("click", async () => {
    yes.disabled = true; no.disabled = true;
    try { await m.onYes?.(); } finally { close(); }
  });
  mask._key = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && e.target === document.body && !yes.disabled) yes.click();
  };
  document.addEventListener("keydown", mask._key);
  (m.focusNo || kind === "danger" ? no : yes).focus();
}

let dismissPasswordModal = null;

export function openPwModal(m) {
  dismissPasswordModal?.();
  const isExport = m.mode === "export" || m.mode === "exportAll";
  const title = m.mode === "export" ? t("pw.exportTitle", { name: esc(m.name) })
    : m.mode === "exportAll" ? t("pw.exportAllTitle", { count: m.count })
    : t("pw.importTitle", { count: m.files.length });
  const sub = isExport
    ? t("pw.exportSub", { path: esc(m.path) })
    : t("pw.importSub", { files: m.files.map(([n]) => esc(n)).join(t("common.listSep")) });

  const mask = document.createElement("div");
  mask.className = "pw-mask";
  const passwordField = (id, label) => `<div class="pw-field">
    <input class="pw-input" type="password" id="${id}" name="${id === "pw1" ? "password" : "password-confirmation"}"
      aria-label="${label}" placeholder="${label}" autocomplete="${isExport ? "new-password" : "current-password"}" spellcheck="false" autocapitalize="off">
    <button type="button" class="btn-ghost pw-toggle" id="${id}-toggle" aria-controls="${id}" aria-label="${t("pw.showPassword")}" aria-pressed="false">${t("pw.show")}</button>
  </div>`;
  const bundleName = isExport ? m.path.split(/[\\/]/).pop() : m.files.map(([name]) => name).join(", ");
  mask.innerHTML = `
    <div class="pw-panel" role="dialog" aria-modal="true" aria-labelledby="pw-title">
      <div class="pw-title" id="pw-title">${title}</div>
      <div class="pw-sub">${sub}</div>
      <input class="pw-username" type="text" name="username" autocomplete="username" value="${esc(bundleName)}" readonly tabindex="-1" aria-hidden="true">
      ${passwordField("pw1", isExport ? t("pw.setPw") : t("pw.pw"))}
      ${isExport ? passwordField("pw2", t("pw.pwAgain")) : ""}
      <div class="pw-err"></div>
      <div class="pw-actions">
        <button class="btn-ghost pw-cancel">${t("common.cancel")}</button>
        <button class="btn-primary pw-go has-ic">${isExport ? ic("lock", 14) + " " + t("pw.encryptExport") : ic("lockOpen", 14) + " " + t("pw.decryptImport")}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const panel = mask.querySelector(".pw-panel");
  const errEl = mask.querySelector(".pw-err");
  const go = mask.querySelector(".pw-go");
  const input1 = mask.querySelector("#pw1");
  const input2 = mask.querySelector("#pw2");
  const fields = [[input1, "#pw1-toggle"], [input2, "#pw2-toggle"]].filter(([input]) => input).map(([input, selector]) => {
    const button = mask.querySelector(selector);
    const setVisible = (visible) => {
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", t(visible ? "pw.hidePassword" : "pw.showPassword"));
      button.textContent = t(visible ? "pw.hide" : "pw.show");
    };
    button.addEventListener("click", () => setVisible(input.type === "password"));
    return { input, button, setVisible };
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fields.forEach(({ input, setVisible }) => { setVisible(false); input.value = ""; });
    if (dismissPasswordModal === close) dismissPasswordModal = null;
    mask.remove();
  };
  dismissPasswordModal = close;
  panel.addEventListener("click", (e) => e.stopPropagation());
  mask.addEventListener("click", close);
  mask.querySelectorAll(".pw-cancel").forEach((b) => b.addEventListener("click", close));
  const key = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
  };
  [input1, input2].forEach((i) => i?.addEventListener("keydown", key));
  mask.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const controls = [...fields.flatMap(({ input, button }) => [input, button]), mask.querySelector(".pw-cancel"), go].filter((control) => !control.disabled);
      const index = controls.indexOf(document.activeElement);
      if (index < 0 || (e.shiftKey && index === 0) || (!e.shiftKey && index === controls.length - 1)) {
        e.preventDefault();
        controls[e.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
  });
  input1.focus();

  async function confirm() {
    if (go.disabled) return;
    const pw1 = input1?.value || "";
    const pw2 = input2?.value;
    if (!pw1.trim()) return (errEl.textContent = t("pw.errEmpty"));
    if (m.mode !== "import" && Array.from(pw1).length < 6) return (errEl.textContent = t("pw.errMinLen"));
    if (pw2 !== undefined && pw2 !== null && pw1 !== pw2) return (errEl.textContent = t("pw.errMismatch"));
    errEl.textContent = "";
    go.disabled = true;
    try {
      if (m.mode === "export") {
        const r = await invoke("export_finalize", { path: m.path, id: m.id, password: pw1 });
        toast(t("pw.exportedToast", { path: r.path }), "ok", t("pw.exportedToastDetail"));
        m.onDone?.(r);
      } else if (m.mode === "exportAll") {
        const r = await invoke("export_all_finalize", { path: m.path, password: pw1 });
        if (r.skipped?.length) {
          close();
          openExportReport(r);
        } else {
          toast(t("pw.exportedAllToast", { count: r.count }), "ok", r.path);
        }
        m.onDone?.(r);
      } else {
        let report = await invoke("import_sealed", { files: m.files, password: pw1 });
        if (m.preErrors?.length) {
          report.errors = [...m.preErrors, ...(report.errors || [])];
        }
        const wrongPw = (report.errors || []).some((e) => /(?:^|[:：]\s*)wrong_password:/.test(String(e)) || String(e).includes("密码错误"));
        if (wrongPw) {
          errEl.textContent = t("pw.errWrong");
          go.disabled = false;
          input1.focus();
          input1.select();
          return;
        }
        m.onDone?.(report);
      }
      close();
    } catch (e) {
      errEl.textContent = stripErr(e);
      go.disabled = false;
    }
  }
  go.addEventListener("click", confirm);
}

export function exportReportText(report) {
  return [
    t("report.title"), t("report.count", { count: report.count }), t("report.path", { path: report.path }),
    t("report.skipped", { count: report.skipped.length }),
    ...report.skipped.map(({ name, reason }) => `${name}: ${reason}`),
  ].join("\n");
}

let dismissExportReport = null;

export function openExportReport(report) {
  dismissExportReport?.();
  const mask = document.createElement("div");
  mask.className = "export-report-mask";
  mask.innerHTML = `<div class="pw-panel export-report-panel" role="dialog" aria-modal="true" aria-labelledby="export-report-title">
    <div class="pw-title" id="export-report-title">${t("report.title")}</div>
    <div class="pw-sub export-report-summary">${esc(t("report.count", { count: report.count }))}<br>${esc(t("report.path", { path: report.path }))}</div>
    <h3>${esc(t("report.skipped", { count: report.skipped.length }))}</h3>
    <div class="export-report-results"><table>
      <thead><tr><th scope="col">${t("report.account")}</th><th scope="col">${t("report.reason")}</th></tr></thead>
      <tbody>${report.skipped.map(({ name, reason }) => `<tr><td>${esc(name)}</td><td>${esc(reason)}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="export-report-status" role="status" aria-live="polite"></div>
    <div class="pw-actions"><button type="button" class="btn-ghost export-report-copy">${t("report.copy")}</button>
      <button type="button" class="btn-primary export-report-close">${t("report.close")}</button></div>
  </div>`;
  const copy = mask.querySelector(".export-report-copy");
  const previous = document.activeElement;
  const closeButton = mask.querySelector(".export-report-close");
  const status = mask.querySelector(".export-report-status");
  const close = () => {
    document.removeEventListener("keydown", key);
    mask.remove();
    if (dismissExportReport === close) dismissExportReport = null;
    if (previous?.isConnected) previous.focus();
  };
  const key = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const buttons = [copy, closeButton].filter((button) => !button.disabled);
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1)) {
        event.preventDefault();
        buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
      }
    }
  };
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    try {
      const text = exportReportText(report);
      if (globalThis.navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement("textarea");
        field.value = text;
        field.readOnly = true;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        try {
          field.select();
          if (!document.execCommand?.("copy")) throw new Error("clipboard unavailable");
        } finally { field.remove(); }
      }
      status.textContent = t("report.copied");
    } catch {
      status.textContent = t("report.copyFailed");
    } finally { copy.disabled = false; copy.focus(); }
  });
  closeButton.addEventListener("click", close);
  document.addEventListener("keydown", key);
  dismissExportReport = close;
  document.body.appendChild(mask);
  copy.focus();
}

export function openProviderModal(m) {
  document.querySelector(".pv-mask")?.remove();
  const mask = document.createElement("div");
  mask.className = "pv-mask";
  const displayOf = (p) => has(`prov.${p.id}`) ? t(`prov.${p.id}`) : p.display;
  mask.innerHTML = `
    <div class="pv-panel">
      <div class="pv-title">${t("prov.title")}</div>
      <div class="pv-sub">${t("prov.sub")}</div>
      <div class="pv-list">
        ${(m.providers || []).map((p) => `
          <button class="pv-item" data-id="${esc(p.id)}">
            <span class="pv-name">${esc(displayOf(p))}</span>
            <span class="pv-arrow">→</span>
          </button>`).join("")}
      </div>
      <div class="pv-actions"><button class="btn-ghost pv-cancel">${t("common.cancel")}</button></div>
    </div>`;
  document.body.appendChild(mask);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  mask.querySelectorAll(".pv-item").forEach((b) => {
    b.addEventListener("click", () => { close(); m.onPick?.(b.dataset.id); });
  });
  mask.querySelector(".pv-cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  const first = mask.querySelector(".pv-item");
  if (first) first.focus();
}
