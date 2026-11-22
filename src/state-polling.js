export function createStateReader(load, apply) {
  let tail = null;

  function refresh() {
    const current = (tail ?? Promise.resolve())
      .catch(() => {})
      .then(load)
      .then((state) => { apply(state); return state; })
      .finally(() => { if (tail === current) tail = null; });
    tail = current;
    return current;
  }

  return { refresh, poll: () => tail ?? refresh() };
}

export function startStatePolling({ read, updated, document, window, setInterval, clearInterval }) {
  let stopped = false;
  let inFlight = false;

  async function tick() {
    if (stopped || document.hidden || inFlight) return;
    inFlight = true;
    try {
      await read();
      if (!stopped && !document.hidden) updated();
    } catch {} finally {
      inFlight = false;
    }
  }

  const timer = setInterval(tick, 5000);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("focus", tick);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", tick);
    window.removeEventListener("focus", tick);
  };
}
