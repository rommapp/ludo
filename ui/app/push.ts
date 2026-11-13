// Backend change nudges (host.events) turned into "refetch this now".
//
// Each background check used to be its own timer asking every 2-5s, mid-game
// included. Now the backend says when a topic changed and the check runs then;
// the timer stays only as a safety net — slow while nudges are known to work,
// at the old pace against a backend that predates them.
import { host } from "@ludo/host";
import { eventsSupported } from "./rpc";

type Run = () => void;
const _subs = new Map<string, Set<Run>>();
let _live = false;
let _started = false;

function _start() {
  if (_started) return;
  _started = true;
  host.events.subscribe((topic) => {
    const runs = topic === '*' ? [..._subs.values()].flatMap((s) => [...s]) : [...(_subs.get(topic) ?? [])];
    for (const r of runs) { try { r(); } catch { /* one watcher's failure isn't the rest's */ } }
  });
  eventsSupported().then((ok) => { _live = ok === true; }).catch(() => { _live = false; });
}

/** Whether the backend is known to send nudges. */
export const pushLive = () => _live;

/**
 * Run `fn` whenever the backend nudges `topic`, and on a timer: every `fastMs`
 * until nudges are confirmed, every `slowMs` once they are. Runs never overlap;
 * a nudge that lands mid-run triggers one more run after it. Returns stop.
 */
export function watchTopic(topic: string, fn: () => unknown, fastMs: number, slowMs: number): () => void {
  _start();
  let running = false, again = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { await fn(); } catch { /* transient: the next nudge or tick retries */ }
    finally {
      running = false;
      if (again && !stopped) { again = false; run(); }
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { run(); schedule(); }, _live ? slowMs : fastMs);
  };
  let set = _subs.get(topic);
  if (!set) { set = new Set(); _subs.set(topic, set); }
  set.add(run);
  schedule();
  return () => { stopped = true; clearTimeout(timer); set!.delete(run); };
}
