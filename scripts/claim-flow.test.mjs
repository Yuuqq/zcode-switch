import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .split("\n(async () => {")[0];

function harness(invoke) {
  const handlers = {}, timers = new Map(), calls = [], toasts = [], logs = [];
  let timerId = 0;
  const context = vm.createContext({
    document: { getElementById: () => ({}) }, window: {},
    crypto: { randomUUID },
    console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    installDelegation: () => {},
    t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    toast: (...args) => toasts.push(args),
    stripErr: (e) => String(e).replace(/^[a-z_]+:/, ""),
    errCode: (e) => String(e).match(/^([a-z_]+):/)?.[1],
    listen: async (event, handler) => { handlers[event] = handler; return () => {}; },
    invoke: async (command, args) => {
      calls.push([command, args]);
      return invoke(command, args, (payload) => handlers["claim://result"]({ payload }));
    },
    setTimeout: (callback, ms) => {
      const id = ++timerId;
      if (ms >= 45000) timers.set(id, callback);
      else queueMicrotask(callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(`${source}
    render = () => {};
    loadAcctQuota = async () => {};
    loadClaimPreview = async () => {};
    scheduleNext = () => {};
    startRefreshTicker = () => {};
    stopRefreshTickerIfIdle = () => {};
    state = { accounts: [{ id: 'account', name: 'Account' }], auto_claim: true };
    autoCooldownReady = true;
    globalThis.api = { actions, runClaimAttempt, autoClaimTick,
      setAccounts: (accounts) => { state.accounts = accounts; },
      snapshot: () => ({ claimable, autoClaimCooldown, autoCooldownReady }) };
  `, context);
  return { api: context.api, calls, handlers, timers, toasts, logs };
}

const success = (args) => ({ accountId: args.id, attemptId: args.attemptId, accountName: "Account", planName: args.planId });

test("fast results resolve before claim_start returns; unrelated attempt results are ignored", async () => {
  const h = harness(async (command, args, emit) => {
    if (command === "claim_start") {
      emit({ ...success(args), attemptId: "old-attempt" });
      emit(success(args));
    }
  });
  const result = await h.api.runClaimAttempt("account", "plan");
  assert.equal(result.planName, "plan");
  assert.equal(h.toasts.length, 1);
  assert.equal(h.calls.at(-1)[0], "claim_cancel");
  assert.equal(h.calls.at(-1)[1].attemptId, result.attemptId);
  assert.equal(h.timers.size, 0);
});

test("manual timeout cancels the same attempt", async () => {
  const h = harness(async () => {});
  h.api.snapshot().claimable.account = { plans: [{ plan_id: "plan" }] };
  const pending = h.api.actions.claim("account");
  await new Promise(setImmediate);
  for (const callback of h.timers.values()) callback();
  await pending;
  const start = h.calls.find(([command]) => command === "claim_start");
  const cancel = h.calls.find(([command]) => command === "claim_cancel");
  assert.equal(cancel[1].attemptId, start[1].attemptId);
  assert.equal(h.timers.size, 0);
});

test("claim all exhausts fresh plans, retries transient failure, and summarizes per account", async () => {
  let plans = [{ plan_id: "one" }, { plan_id: "two" }], starts = 0;
  const h = harness(async (command, args, emit) => {
    if (command === "claim_preview") return [...plans];
    if (command === "claim_start") {
      starts++;
      if (starts === 1) emit({ ...success(args), ok: false, retryable: true, message: "network" });
      else { plans = plans.filter((p) => p.plan_id !== args.planId); emit(success(args)); }
    }
  });
  await h.api.actions.claimAll();
  assert.equal(starts, 3);
  assert.equal(new Set(h.calls.filter(([cmd]) => cmd === "claim_start").map(([, args]) => args.attemptId)).size, 3);
  assert.match(h.toasts.at(-1)[2], /"count":2/);
  assert.equal(h.calls.filter(([cmd]) => cmd === "claim_preview").length, 4);
});

test("business errors are not retried; empty eligibility starts no verification", async () => {
  for (const empty of [false, true]) {
    let starts = 0;
    const h = harness(async (command, args, emit) => {
      if (command === "claim_preview") return empty ? [] : [{ plan_id: "one" }];
      if (command === "claim_start") { starts++; emit({ ...success(args), ok: false, code: 1005, retryable: false, message: "business" }); }
    });
    await h.api.actions.claimAll();
    assert.equal(starts, empty ? 0 : 1);
    assert.match(h.toasts.at(-1)[2], /"count":0/);
  }
});

test("auto refresh failure clears stale plans, persists cooldown, and logs activation diagnostics", async () => {
  let refreshes = 0, starts = 0;
  const h = harness(async (command, args, emit) => {
    if (command === "claim_refresh") {
      if (++refreshes > 1) throw "transient:preview failed";
      return { plans: [{ plan_id: "one" }], activated: false, activationError: "activation failed" };
    }
    if (command === "claim_start") { starts++; emit(success(args)); }
    if (command === "claim_preview") throw "transient:preview failed";
  });
  await h.api.autoClaimTick();
  assert.equal(starts, 1);
  assert.equal(h.api.snapshot().claimable.account.stale, true);
  assert.equal(h.api.snapshot().claimable.account.plans.length, 0);
  assert.ok(h.calls.some(([cmd, args]) => cmd === "claim_set_cooldown" && args.until > Date.now()));
  assert.ok(h.logs.some((args) => args[1]?.activationError === "activation failed"));
  h.api.snapshot().autoClaimCooldown.account = 0;
  await h.api.autoClaimTick();
  assert.equal(starts, 1);
});

test("claim all caps successes and never repeats a successfully claimed plan", async () => {
  let starts = 0;
  const plans = Array.from({ length: 7 }, (_, i) => ({ plan_id: String(i) }));
  const h = harness(async (command, args, emit) => {
    if (command === "claim_preview") return plans;
    if (command === "claim_start") { starts++; emit(success(args)); }
  });
  await h.api.actions.claimAll();
  assert.equal(starts, 5);
  assert.equal(new Set(h.calls.filter(([cmd]) => cmd === "claim_start").map(([, args]) => args.planId)).size, 5);
  assert.match(h.toasts.at(-1)[2], /m.claimCap/);
});

test("transient retries are limited to three attempts", async () => {
  let starts = 0;
  const h = harness(async (command, args, emit) => {
    if (command === "claim_preview") return [{ plan_id: "one" }];
    if (command === "claim_start") { starts++; emit({ ...success(args), ok: false, retryable: true, message: "network" }); }
  });
  await h.api.actions.claimAll();
  assert.equal(starts, 3);
  assert.match(h.toasts.at(-1)[2], /"count":0/);
});

test("cooldown persistence failure pauses future auto rounds", async () => {
  let starts = 0;
  const h = harness(async (command, args, emit) => {
    if (command === "claim_refresh") return { plans: [{ plan_id: "one" }] };
    if (command === "claim_start") { starts++; emit({ ...success(args), ok: false, code: 1005 }); }
    if (command === "claim_set_cooldown") throw "disk error";
  });
  await h.api.autoClaimTick();
  assert.equal(h.api.snapshot().autoCooldownReady, false);
  await h.api.autoClaimTick();
  assert.equal(starts, 1);
});

for (const scenario of [
  { name: "all successful", results: [{ plans: [{ plan_id: "one" }] }, { plans: [] }], n: 2, k: 1, kind: "ok" },
  { name: "empty eligibility", results: [{ plans: [] }], n: 1, k: 0, kind: "ok" },
  { name: "mixed success and failure", results: [{ plans: [] }, new Error("quota/eligibility unavailable")], n: 1, k: 0, f: 1, kind: "warn" },
  { name: "all failed", results: [new Error("refresh unavailable")], n: 0, k: 0, f: 1, kind: "err" },
  { name: "activation warning", results: [{ plans: [], activationError: "report failed" }], n: 1, k: 0, w: 1, kind: "warn" },
]) {
  test(`eligibility refresh summary: ${scenario.name}`, async () => {
    const h = harness(async (command, args) => {
      if (command !== "claim_refresh") throw new Error(`Unexpected command: ${command}`);
      const result = scenario.results[Number(args.id)];
      if (result instanceof Error) throw result;
      return result;
    });
    h.api.setAccounts(scenario.results.map((_, i) => ({ id: String(i), name: `Account ${i}` })));
    await h.api.actions.refreshClaim();
    const [message, kind] = h.toasts.at(-1);
    assert.equal(kind, scenario.kind);
    const params = JSON.parse(message.slice(message.indexOf(":") + 1));
    assert.equal(params.n, scenario.n);
    assert.equal(params.k, scenario.k);
    if (scenario.kind !== "ok") {
      assert.equal(params.f, scenario.f || 0);
      assert.equal(params.w, scenario.w || 0);
      assert.ok(h.toasts.every(([, type]) => type !== "ok"));
    }
  });
}

test("eligibility refresh with no accounts does not invoke or announce success", async () => {
  const h = harness(async () => { throw new Error("No request expected"); });
  h.api.setAccounts([]);
  await h.api.actions.refreshClaim();
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
});
