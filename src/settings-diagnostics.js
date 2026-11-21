import { esc } from "./ui.js";
import { t } from "./i18n.js";

const categories = {
  ok: "diag.ok", dns: "diag.dns", refused: "diag.refused", timeout: "diag.timeout", tls: "diag.tls",
  proxy_auth: "diag.proxyAuth", http: "diag.http", invalid_proxy: "diag.invalidProxy",
  proxy_connect: "diag.proxyConnect", connect: "diag.connect", network: "diag.network",
};

function probeText(probe) {
  return esc(t("diag.result", {
    category: t(categories[probe.category] || categories.network), ms: probe.latency_ms,
    status: probe.status == null ? "" : `HTTP ${probe.status}`,
  }));
}

export function connectivityHtml(report) {
  if (!report) return "";
  return `<div class="diagnostic-results" role="status">
    <p>${esc(t("diag.route", { proxy: report.proxy || t("diag.direct") }))}</p>
    <table><thead><tr><th>${t("diag.target")}</th><th>${t("diag.enteredRoute")}</th><th>${t("diag.directFallback")}</th></tr></thead>
      <tbody>${report.targets.map((target) => `<tr>
        <td>${t(target.group === "backend" ? "diag.backend" : "diag.login")}<br>${esc(target.url)}</td>
        <td class="${target.primary.ok ? "diagnostic-ok" : "diagnostic-warn"}">${probeText(target.primary)}</td>
        <td>${target.direct ? probeText(target.direct) : t("diag.notRun")}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
}

export function releaseUrl(version) {
  return version
    ? `https://github.com/Yuuqq/zcode-switch/releases/download/v${encodeURIComponent(version)}/zcode-switch-magpie-plugin-v${encodeURIComponent(version)}.zip`
    : "https://github.com/Yuuqq/zcode-switch/releases/latest";
}

export function installSteps(version) {
  return `${releaseUrl(version)}\n${t("diag.extract")}\nmagpie plugin add /absolute/path/zcode-switch-magpie-plugin`;
}

export function magpieHtml(diagnostics, version) {
  const yesNo = (value) => t(value ? "diag.yes" : "diag.no");
  const summary = diagnostics ? `
    <dl class="diagnostic-facts">
      <dt>${t("diag.library")}</dt><dd>${esc(diagnostics.library_path)}</dd>
      <dt>${t("diag.snapshots")}</dt><dd>${esc(t("diag.counts", diagnostics.counts))}</dd>
      <dt>${t("diag.cli")}</dt><dd>${yesNo(diagnostics.cli_found)}</dd>
      <dt>${t("diag.config")}</dt><dd>${esc(diagnostics.config_path)} · ${yesNo(diagnostics.config_exists)}</dd>
      <dt>ZCODE_CREDENTIAL_SECRET</dt><dd>${yesNo(diagnostics.secret_set)}</dd>
      <dt>${t("diag.node")}</dt><dd>${esc(diagnostics.node_version || t("diag.notFound"))} · ${t("diag.nodeSupported", { supported: yesNo(diagnostics.node_supported) })}</dd>
    </dl>
    ${!diagnostics.library_readable ? `<p class="diagnostic-warn">${t("diag.libraryError")}</p>` : ""}` : "";
  return `${summary}
    <p class="diagnostic-hint">${esc(t("diag.readOnly"))}</p>
    <p class="diagnostic-hint">${esc(t("diag.recover"))}</p>
    <p><a class="gh-link" href="${esc(releaseUrl(version))}" click="actions.openMagpieRelease()">${t("diag.download")}</a></p>
    <textarea class="magpie-install" readonly rows="5" spellcheck="false" aria-label="${t("diag.steps")}">${esc(installSteps(version))}</textarea>
    <button class="btn-ghost" click="actions.copyMagpieSteps()">${t("diag.copySteps")}</button>`;
}
