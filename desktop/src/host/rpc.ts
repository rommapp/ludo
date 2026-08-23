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
