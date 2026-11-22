import { readFileSync } from "node:fs";
import vm from "node:vm";

const main = readFileSync(process.argv[2] || new URL("../src/main.js", import.meta.url), "utf8");
const improved = main.includes("startStatePolling(");
const policy = improved
  ? readFileSync(new URL("../src/state-polling.js", import.meta.url), "utf8").replace(/^export /gm, "")
  : "";
const original = main.match(/setInterval\(\(\) => \{\s*invoke\("get_state"\)[\s\S]*?\}, 5000\);/)?.[0];
const reader = main.match(/const stateReader = createStateReader\([\s\S]*?\n\}\);/)?.[0];
const polling = main.match(/startStatePolling\(\{[\s\S]*?\n    \}\);/)?.[0];
if (!improved && !original) throw new Error("could not locate polling implementation");
if (improved && (!reader || !polling)) throw new Error("could not locate state reader and polling setup");

class Events {
  handlers = new Map();
  addEventListener(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); }
  removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); }
  emit(name) { for (const fn of this.handlers.get(name) || []) fn(); }
}

async function trace(name, hidden, latency) {
  let now = 0, sequence = 0, calls = 0, active = 0, peak = 0;
  const timers = new Map();
  const document = new Events(), window = new Events();
  document.hidden = hidden;
  const timer = (fn, delay, repeat) => { timers.set(++sequence, { fn, at: now + delay, repeat }); return sequence; };
  const load = () => {
    calls++; active++; peak = Math.max(peak, active);
    return new Promise((resolve) => timer(() => { active--; resolve({ accounts: [] }); }, latency, 0));
  };
  const context = vm.createContext({
    document, window, invoke: load, state: null, init() {}, enrollAccounts() {}, uiLocked: () => false, render() {},
    setInterval: (fn, delay) => timer(fn, delay, delay), clearInterval: (id) => timers.delete(id),
  });
  const start = improved
    ? `${policy}\n${reader}\n${polling}`
    : original;
  vm.runInContext(start, context);
  while (true) {
    let next;
    for (const entry of timers) {
      if (entry[1].at <= 60_000 && (!next || entry[1].at < next[1].at)) next = entry;
    }
    if (!next) break;
    const [id, event] = next;
    now = event.at;
    if (event.repeat) event.at += event.repeat; else timers.delete(id);
    event.fn();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  return { name, calls, peak_in_flight: peak };
}

const scenarios = [];
for (const [name, hidden, latency] of [["visible", false, 100], ["hidden", true, 100], ["slow-visible", false, 6000]]) {
  scenarios.push(await trace(name, hidden, latency));
}
console.log(JSON.stringify({ duration_ms: 60_000, scenarios }, null, 2));
