import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function harness() {
  const warnings = [];
  const source = readFileSync(new URL("../src/switch-probe.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const context = vm.createContext({ warn: (outcome, name) => warnings.push([outcome.kind, name]) });
  vm.runInContext(`${source}\nglobalThis.tracker = createSwitchProbeTracker(warn);`, context);
  return { tracker: context.tracker, warnings };
}

const result = (id) => ({ operation_id: id, name: `Account ${id}` });
const event = (id, kind) => ({ operation_id: id, outcome: kind ? { kind } : null });

test("latest operation gets a separate negative warning; stale and duplicate events are ignored", () => {
  const { tracker, warnings } = harness();
  tracker.begin();
  tracker.complete(result("old"));
  tracker.begin();
  tracker.receive(event("old", "no_entitlement"));
  tracker.complete(result("new"));
  tracker.receive(event("old", "auth_failed"));
  tracker.receive(event("new", "auth_failed"));
  tracker.receive(event("new", "auth_failed"));
  assert.deepEqual(warnings, [["auth_failed", "Account new"]]);
});

test("probe events racing the command response wait until the immediate switch toast", () => {
  const { tracker, warnings } = harness();
  tracker.begin();
  tracker.receive(event("new", "no_entitlement"));
  assert.deepEqual(warnings, []);
  tracker.complete(result("new"));
  assert.deepEqual(warnings, [["no_entitlement", "Account new"]]);
});

test("entitled, inconclusive, missing and failed-switch events do not warn", () => {
  const { tracker, warnings } = harness();
  for (const kind of ["entitled", null, "unknown"]) {
    tracker.begin();
    tracker.complete(result("new"));
    tracker.receive(event("new", kind));
  }
  tracker.receive(null);
  tracker.receive({});
  tracker.begin();
  tracker.receive(event("failed", "auth_failed"));
  tracker.cancel();
  tracker.receive(event("failed", "auth_failed"));
  assert.deepEqual(warnings, []);
});

test("switch response shows success, refreshes and schedules quota without waiting for a probe", async () => {
  const calls = [];
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const action = source.slice(source.indexOf("async doSwitch(id, force)"), source.indexOf("async updateFromLive(id)"));
  const { tracker, warnings } = harness();
  const context = vm.createContext({
    guard: (fn) => fn(), state: { launch_after_switch: false }, switchProbes: tracker,
    switchProbeReady: Promise.resolve(),
    invoke: async () => ({ ...result("new"), switched: true }),
    toast: (_, kind) => calls.push(kind), t: (key) => key,
    refresh: async () => calls.push("refresh"), render: () => calls.push("render"),
    pokeAccount: () => calls.push("quota"),
  });
  vm.runInContext(`globalThis.actions = { ${action} };`, context);
  await context.actions.doSwitch("target", false);
  assert.deepEqual(calls, ["ok", "quota", "refresh", "render"]);
  assert.deepEqual(warnings, []);
  tracker.receive(event("new", "no_entitlement"));
  assert.deepEqual(warnings, [["no_entitlement", "Account new"]]);
});
