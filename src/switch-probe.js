export function createSwitchProbeTracker(warn) {
  let pending = false;
  let latest = null;
  let name = "";
  const early = new Map();

  function receive(event) {
    if (!event?.operation_id) return;
    if (pending) {
      early.set(event.operation_id, event);
      return;
    }
    if (event.operation_id !== latest) return;
    latest = null;
    if (event.outcome?.kind === "no_entitlement" || event.outcome?.kind === "auth_failed") {
      warn(event.outcome, name);
    }
  }

  return {
    begin() {
      pending = true;
      latest = null;
      early.clear();
    },
    complete(result) {
      pending = false;
      latest = result.operation_id ?? null;
      name = result.name;
      const event = early.get(latest);
      early.clear();
      if (event) receive(event);
    },
    cancel() {
      pending = false;
      latest = null;
      early.clear();
    },
    receive,
  };
}
