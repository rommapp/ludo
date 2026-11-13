/**
 * Reaching the backend from this shell.
 *
 * Decky's `callable` binds a name to a Python method on the plugin backend and
 * marshals positional args. The desktop backend mirrors that contract exactly,
 * so the call sites in the shared UI need no changes: POST /api/<method> with
 * {args: [...]}, reply {result} or {error}.
 *
 * Deliberately React-free and dependency-free, so the parts of this adapter
 * that only talk to the backend stay testable on their own.
 */
const RPC_BASE = "/api";

export function callable<A extends any[], R>(method: string) {
  return async (...args: A): Promise<R> => {
    const res = await fetch(`${RPC_BASE}/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
    if (!res.ok) {
      throw new Error(`${method}: HTTP ${res.status} ${res.statusText}`);
    }
    const payload = await res.json();
    if (payload && payload.error) throw new Error(String(payload.error));
    return payload.result as R;
  };
}

/**
 * Backend change nudges over one held-open request (see EventLog in
 * backend/server.py), shared by every subscriber in this window. `fn('*')`
 * after the channel recovers from an error or a backend restart, since nudges
 * may have been missed meanwhile. The request runs only while someone listens.
 */
const _eventSubs = new Set<(topic: string) => void>();
let _eventLoop = false;

async function _runEventLoop() {
  _eventLoop = true;
  let after = 0;
  let first = true;
  let broken = false;
  const emit = (t: string) => _eventSubs.forEach((fn) => { try { fn(t); } catch { /* not ours to fail */ } });
  while (_eventSubs.size) {
    try {
      const res = await fetch(`${RPC_BASE}/_events?after=${after}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const reset = !!j.reset || broken;
      after = Number(j.seq) || 0;
      broken = false;
      // The first answer replays whatever happened before we connected.
      if (first) { first = false; continue; }
      if (reset) { emit('*'); continue; }
      for (const t of j.topics || []) emit(String(t));
    } catch {
      broken = true;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  _eventLoop = false;
}

export function subscribeEvents(fn: (topic: string) => void): () => void {
  _eventSubs.add(fn);
  if (!_eventLoop) _runEventLoop();
  return () => { _eventSubs.delete(fn); };
}
