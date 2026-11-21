import { esc } from "./ui.js";
import { t } from "./i18n.js";

let dismiss = null;

export function pickClaimPlan(plans, { accountName, describePlan }) {
  dismiss?.();
  if (!plans.length) return Promise.resolve(null);
  if (plans.length === 1) return Promise.resolve(plans[0].plan_id);
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const mask = document.createElement("div");
    mask.className = "pv-mask plan-picker-mask";
    mask.innerHTML = `<div class="pv-panel" role="dialog" aria-modal="true" aria-labelledby="plan-picker-title">
      <div class="pv-title" id="plan-picker-title">${esc(t("m.planPickerTitle", { name: accountName }))}</div>
      <div class="pv-sub">${t("m.planPickerHint")}</div>
      <div class="pv-list plan-picker-list">${plans.map((plan, index) => `
        <button class="pv-item plan-choice" data-index="${index}">
          <span class="plan-choice-name">${esc(plan.name || plan.plan_id)}</span>
          <span class="plan-choice-id">${esc(plan.plan_id)}</span>
          ${describePlan(plan) ? `<span class="plan-choice-detail">${esc(describePlan(plan))}</span>` : ""}
          ${plan.description ? `<span class="plan-choice-detail">${esc(plan.description)}</span>` : ""}
        </button>`).join("")}
      </div>
      <div class="pv-actions"><button class="btn-ghost plan-picker-cancel">${t("common.cancel")}</button></div>
    </div>`;
    const choices = [...mask.querySelectorAll(".plan-choice")];
    const cancel = mask.querySelector(".plan-picker-cancel");
    const buttons = [...choices, cancel];
    let settled = false;
    const finish = (planId = null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      mask.remove();
      dismiss = null;
      if (previous?.isConnected) previous.focus();
      resolve(planId);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); finish(); }
      if (event.key === "Tab") {
        const index = buttons.indexOf(document.activeElement);
        if ((event.shiftKey && index <= 0) || (!event.shiftKey && (index === buttons.length - 1 || index < 0))) {
          event.preventDefault();
          buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
        }
      }
    };
    choices.forEach((button, index) => button.addEventListener("click", () => finish(plans[index].plan_id)));
    cancel.addEventListener("click", () => finish());
    mask.addEventListener("click", (event) => { if (event.target === mask) finish(); });
    document.addEventListener("keydown", onKey);
    dismiss = finish;
    document.body.appendChild(mask);
    choices[0].focus();
  });
}
