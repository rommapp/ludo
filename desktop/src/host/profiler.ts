// Frame profiler overlay. F9 toggles it (remembered across launches).
//
// Shows live FPS, a frame-time graph, p50/p95/max and dropped frames over the
// last ~2s, plus long tasks (main-thread work >50ms, which is what blocks rAF).
// Scroll animations report themselves through profileSpan(), so each finished
// glide is logged to the console with ITS OWN frame stats — the number that
// answers "is the animation choppy" without the idle frames diluting it.
//
// Frame time is the rAF-to-rAF delta: when the compositor can't keep up, or the
// main thread is busy, that delta stretches past one refresh interval.

const STORE_KEY = "ludo.profiler";
const WINDOW = 120; // frames kept for the graph / rolling stats

let enabled = false;
let raf = 0;
let last = 0;
let refresh = 1000 / 60; // estimated vsync interval, refined from the samples
const deltas: number[] = [];
let longTasks: { t: number; dur: number }[] = [];
let el: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let text: HTMLPreElement | null = null;

// Open spans: name -> collected deltas while active (ref-counted per name).
const spans = new Map<string, { depth: number; start: number; d: number[]; long: number }>();

/** Mark a span of work (e.g. one scroll glide). Call the returned fn to end it. */
export function profileSpan(name: string): () => void {
  if (!enabled) return noop;
  let s = spans.get(name);
  if (!s) { s = { depth: 0, start: performance.now(), d: [], long: 0 }; spans.set(name, s); }
  s.depth++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = spans.get(name);
    if (!cur || --cur.depth > 0) return;
    spans.delete(name);
    report(name, cur);
  };
}
function noop() { /* profiler off */ }

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function stats(d: number[]) {
  const s = [...d].sort((a, b) => a - b);
  const total = d.reduce((a, b) => a + b, 0);
  // A frame that took more than 1.5 refresh intervals missed at least one vsync.
  const dropped = d.reduce((n, x) => n + Math.max(0, Math.round(x / refresh) - 1), 0);
  return {
    fps: total ? (d.length * 1000) / total : 0,
    p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1] ?? 0, dropped,
  };
}

function report(name: string, s: { start: number; d: number[]; long: number }) {
  if (s.d.length < 2) return;
  const st = stats(s.d);
  const ms = (performance.now() - s.start).toFixed(0);
  // eslint-disable-next-line no-console
  console.log(
    `[profiler] ${name}: ${ms}ms, ${s.d.length} frames, ${st.fps.toFixed(1)} fps, ` +
    `p50 ${st.p50.toFixed(1)} / p95 ${st.p95.toFixed(1)} / max ${st.max.toFixed(1)} ms, ` +
    `${st.dropped} dropped, ${s.long} long tasks`,
  );
}

function frame(now: number) {
  if (last) {
    const d = now - last;
    deltas.push(d);
    if (deltas.length > WINDOW) deltas.shift();
    for (const s of spans.values()) s.d.push(d);
    // The shortest common delta approximates vsync (handles 60/90/120Hz).
    if (deltas.length >= 30) {
      const p10 = pct([...deltas].sort((a, b) => a - b), 0.1);
      if (p10 > 4) refresh = p10;
    }
  }
  last = now;
  draw(now);
  raf = requestAnimationFrame(frame);
}

function draw(now: number) {
  if (!canvas || !text) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const scale = h / (refresh * 4); // graph tops out at 4 frames
  // Budget line at one refresh interval.
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(0, h - refresh * scale, w, 1);
  const bw = w / WINDOW;
  deltas.forEach((d, i) => {
    ctx.fillStyle = d > refresh * 1.5 ? "#ff5a4a" : d > refresh * 1.15 ? "#ffc23d" : "#4ade80";
    const bh = Math.min(h, d * scale);
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
  });
  longTasks = longTasks.filter((t) => now - t.t < 2000);
  const st = stats(deltas);
  const active = [...spans.keys()].join(", ") || "-";
  text.textContent =
    `${st.fps.toFixed(0)} fps  (vsync ${refresh.toFixed(1)}ms)\n` +
    `p50 ${st.p50.toFixed(1)}  p95 ${st.p95.toFixed(1)}  max ${st.max.toFixed(1)}\n` +
    `dropped ${st.dropped}  long tasks ${longTasks.length}` +
    (longTasks.length ? ` (${Math.max(...longTasks.map((t) => t.dur)).toFixed(0)}ms)` : "") +
    `\nanim: ${active}`;
}

let observer: PerformanceObserver | null = null;

function start() {
  if (enabled) return;
  enabled = true;
  el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:2147483647;pointer-events:none;" +
    "background:rgba(0,0,0,0.75);color:#fff;font:11px/1.35 monospace;" +
    "padding:6px 8px;border-radius:6px;";
  canvas = document.createElement("canvas");
  canvas.width = 240; canvas.height = 60;
  canvas.style.cssText = "display:block;width:240px;height:60px;margin-bottom:4px;";
  text = document.createElement("pre");
  text.style.cssText = "margin:0;font:inherit;white-space:pre;";
  el.append(canvas, text);
  document.body.appendChild(el);
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.push({ t: performance.now(), dur: e.duration });
        for (const s of spans.values()) s.long++;
      }
    });
    observer.observe({ type: "longtask", buffered: false } as PerformanceObserverInit);
  } catch { observer = null; }
  last = 0;
  deltas.length = 0;
  raf = requestAnimationFrame(frame);
}

function stop() {
  if (!enabled) return;
  enabled = false;
  cancelAnimationFrame(raf);
  observer?.disconnect();
  observer = null;
  spans.clear();
  el?.remove();
  el = canvas = null; text = null;
}

export function startProfiler() {
  let on = false;
  try { on = localStorage.getItem(STORE_KEY) === "1"; } catch { /* ignore */ }
  if (on) start();
  window.addEventListener("keydown", (e) => {
    if (e.key !== "F9" || e.repeat) return;
    e.preventDefault();
    if (enabled) stop(); else start();
    try { localStorage.setItem(STORE_KEY, enabled ? "1" : "0"); } catch { /* ignore */ }
  }, true);
}
