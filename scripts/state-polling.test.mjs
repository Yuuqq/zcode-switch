import assert from "node:assert/strict";
import test from "node:test";
import { createStateReader, startStatePolling } from "../src/state-polling.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

class Events {
  handlers = new Map();
  addEventListener(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); }
  removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); }
  emit(name) { for (const fn of this.handlers.get(name) || []) fn(); }
}

function harness(load = async () => ({})) {
  const document = new Events(), window = new Events();
  document.hidden = false;
  const applied = [], timers = new Map();
  let updates = 0, reads = 0;
  const reader = createStateReader(() => { reads++; return load(); }, (state) => applied.push(state));
  const stop = startStatePolling({
    read: () => reader.poll(), updated: () => updates++, document, window,
    setInterval: (fn, period) => { assert.equal(period, 5000); timers.set(1, fn); return 1; },
    clearInterval: (id) => timers.delete(id),
  });
  return { document, window, applied, reader, stop,
    get reads() { return reads; }, get updates() { return updates; },
    async tick() { for (const fn of timers.values()) fn(); await settle(); },
  };
}

test("visible polling remains 5s, hidden polls do no work, and visibility/focus resume coalesces", async () => {
  const h = harness();
  assert.equal(h.reads, 0);
  await h.tick();
  assert.equal(h.reads, 1);
  h.document.hidden = true;
  h.document.emit("visibilitychange");
  h.window.emit("focus");
  for (let i = 0; i < 12; i++) await h.tick();
  assert.equal(h.reads, 1);
  h.document.hidden = false;
  h.document.emit("visibilitychange");
  h.window.emit("focus");
  await settle();
  assert.equal(h.reads, 2);
  assert.equal(h.updates, 2);
  h.stop();
  await h.tick();
  h.document.emit("visibilitychange");
  h.window.emit("focus");
  await settle();
  assert.equal(h.reads, 2);
});

test("slow polls never overlap; becoming hidden suppresses rendering of their result", async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  await h.tick();
  await h.tick();
  h.window.emit("focus");
  assert.equal(h.reads, 1);
  h.document.hidden = true;
  pending.resolve({ accounts: [] });
  await settle();
  assert.equal(h.updates, 0);
  assert.deepEqual(h.applied, [{ accounts: [] }]);
  h.document.hidden = false;
  h.window.emit("focus");
  await settle();
  assert.equal(h.reads, 2);
  assert.equal(h.updates, 1);
});

test("explicit post-mutation refresh queues a fresh read instead of accepting an old poll snapshot", async () => {
  const old = deferred();
  let calls = 0, active = 0, peak = 0;
  const seen = [];
  const reader = createStateReader(async () => {
    calls++; active++; peak = Math.max(peak, active);
    const state = calls === 1 ? await old.promise : { name: "renamed" };
    active--; return state;
  }, (state) => seen.push(state));
  const poll = reader.poll();
  await settle();
  const fresh = reader.refresh();
  assert.equal(reader.poll(), fresh);
  assert.equal(calls, 1);
  old.resolve({ name: "old" });
  await poll;
  assert.deepEqual(await fresh, { name: "renamed" });
  assert.deepEqual(seen, [{ name: "old" }, { name: "renamed" }]);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
});

test("background read failures recover, explicit failures propagate, and queued reads still run", async () => {
  let calls = 0;
  const h = harness(async () => { if (++calls === 1) throw new Error("unreadable"); return { accounts: [] }; });
  await h.tick();
  assert.equal(h.updates, 0);
  await h.tick();
  assert.equal(h.updates, 1);
  const reader = createStateReader(async () => { throw new Error("failure"); }, () => {});
  await assert.rejects(reader.refresh(), /failure/);
  const pending = deferred();
  let count = 0;
  const queued = createStateReader(() => ++count === 1 ? pending.promise : Promise.resolve({}), () => {});
  const first = queued.poll();
  const next = queued.refresh();
  pending.reject(new Error("old failure"));
  await assert.rejects(first, /old failure/);
  assert.deepEqual(await next, {});
});

test("explicit refresh remains available while hidden and does not cache empty account lists", async () => {
  const h = harness(async () => ({ accounts: [] }));
  h.document.hidden = true;
  await h.reader.refresh();
  await h.reader.refresh();
  assert.equal(h.reads, 2);
  assert.deepEqual(h.applied, [{ accounts: [] }, { accounts: [] }]);
  await h.tick();
  assert.equal(h.reads, 2);
});
