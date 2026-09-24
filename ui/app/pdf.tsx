import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { V2 } from "./theme";

// PDF pages for the walkthrough reader, drawn with pdf.js.
//
// The pages stack in the reader's own scrolling pane, so the pad scrolls,
// pages, jumps sections and remembers its place in a PDF exactly as it does in
// a text guide. Only pages near the view are drawn; the rest are placeholders
// of their real size, so a 300-page manual opens as fast as a 3-page one and
// the scrollbar is right from the start.
//
// pdf.js is loaded on first use. Its worker runs on the main thread (the
// "fake worker", enabled by handing pdf.js the worker module as
// globalThis.pdfjsWorker): a separate worker file would need its own URL, which
// the Decky build, shipped as a single file, cannot give it. Guides are small
// enough that parsing on the main thread is not felt.

let lib: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  if (!lib) {
    lib = (async () => {
      const [m, w] = await Promise.all([
        // The legacy build: the modern one relies on JavaScript newer than
        // Electron's Chromium, let alone the Deck's Steam client
        // (Map.prototype.getOrInsertComputed, first failure seen).
        // @ts-ignore -- the legacy entry ships without its own declarations
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        // @ts-ignore -- as above, for the worker module
        import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
      ]);
      (globalThis as any).pdfjsWorker = w;
      return m;
    })();
    lib.catch(() => { lib = null; });
  }
  return lib;
}

export type PdfSection = { title: string; page: number; y: number };
type Loaded = { pdf: any; sizes: { w: number; h: number }[]; sections: PdfSection[] };

// Open a PDF and read what the layout needs up front: every page's size (so
// the placeholders are right before anything is drawn) and its bookmarks.
export async function openPdf(data: Uint8Array): Promise<Loaded> {
  const m = await pdfjs();
  const pdf = await m.getDocument({ data, isEvalSupported: false }).promise;
  const sizes: { w: number; h: number }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return { pdf, sizes, sections: await readOutline(pdf, sizes) };
}

// Bookmarks, two levels deep, resolved to a page and a y offset on it (in
// unscaled page units, from the top). A PDF without them gets a section per
// page, so left/right still turns pages and the list still navigates.
async function readOutline(pdf: any, sizes: { w: number; h: number }[]): Promise<PdfSection[]> {
  const out: PdfSection[] = [];
  const walk = async (items: any[], depth: number) => {
    for (const it of items || []) {
      try {
        const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
        if (Array.isArray(dest) && dest[0]) {
          const page = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          // [ref, {name:'XYZ'}, left, top, zoom]: top counts up from the page
          // bottom. Other fit modes land on the page's top.
          const top = dest[1]?.name === 'XYZ' && typeof dest[3] === 'number' ? dest[3] : null;
          const h = sizes[page]?.h ?? 0;
          const y = top == null ? 0 : Math.max(0, Math.min(h, h - top));
          const title = String(it.title || '').trim();
          if (title) out.push({ title, page, y });
        }
      } catch { /* a broken bookmark is skipped, not fatal */ }
      if (depth < 1 && it.items?.length) await walk(it.items, depth + 1);
    }
  };
  try { await walk(await pdf.getOutline(), 0); } catch { /* no outline */ }
  if (!out.length) return sizes.map((_, i) => ({ title: `Page ${i + 1}`, page: i, y: 0 }));
  // Section navigation needs document order; outlines are not always in it.
  return out.sort((a, b) => a.page - b.page || a.y - b.y);
}

// Pages in the reader's colours. pdf.js's high-contrast mode redraws the page
// background and everything vector (text, rules, tables) mapped between these
// two by lightness, and leaves images alone, so photos and box art stay true
// instead of turning negative the way a CSS invert would.
const PAGE_BG = '#16161f';
const PAGE_COLORS = { background: PAGE_BG, foreground: '#e6e6ee' };

const GAP = 14;        // between pages, px
const MAX_W = 980;     // a page never grows past this at zoom 1

// The pages themselves. `zoom` multiplies the fit-to-width scale; `width` is
// the pane's inner width.
export function PdfPages({ doc, zoom, width, dark, onLaidOut }: {
  doc: Loaded; zoom: number; width: number; dark: boolean; onLaidOut: () => void;
}) {
  const base = Math.min(width - 32, MAX_W) / Math.max(...doc.sizes.map((s) => s.w));
  const scale = Math.max(0.1, base * zoom);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([0, 1]));
  const wraps = useRef<(HTMLDivElement | null)[]>([]);

  // Draw what is on (or near) screen.
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      setVisible((prev) => {
        const next = new Set(prev);
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) next.add(i); else next.delete(i);
        }
        return next;
      });
    }, { rootMargin: '150% 0px' });
    wraps.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [doc]);

  const laid = useRef(false);
  useLayoutEffect(() => {
    if (laid.current || !width) return;
    laid.current = true;
    onLaidOut();
  }, [width]);

  // Bookmark markers go inside their page at the bookmark's height, carrying
  // data-sec like the text reader's headings — which is all the reader's
  // section tracking and jumping look for.
  const byPage = new Map<number, { sec: number; y: number }[]>();
  doc.sections.forEach((s, i) => {
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    byPage.get(s.page)!.push({ sec: i, y: s.y });
  });

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${GAP}px`,
      padding: '16px 16px 40vh', animation: 'rdFade 0.4s ease both',
    }}>
      {doc.sizes.map((s, i) => (
        <div key={i} data-page={i} ref={(el) => { wraps.current[i] = el; }} style={{
          position: 'relative', flexShrink: 0,
          width: `${Math.floor(s.w * scale)}px`, height: `${Math.floor(s.h * scale)}px`,
          background: dark ? PAGE_BG : '#fff', transition: 'background 0.25s ease', borderRadius: V2.radiusSm, overflow: 'hidden',
          border: `1px solid ${V2.border}`, boxSizing: 'border-box',
          boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
        }}>
          {(byPage.get(i) || []).map((m) => (
            <div key={m.sec} data-sec={m.sec} style={{ position: 'absolute', left: 0, top: `${m.y * scale}px`, height: 0, width: 0 }} />
          ))}
          {visible.has(i) && <PdfCanvas pdf={doc.pdf} index={i} scale={scale} dark={dark} />}
          <div style={{
            position: 'absolute', right: '8px', bottom: '6px', fontSize: '10px', fontFamily: V2.font,
            color: dark ? V2.fgFaint : 'rgba(0,0,0,0.35)', pointerEvents: 'none',
          }}>{i + 1}</div>
        </div>
      ))}
    </div>
  );
}

// One page, drawn at the current scale and the screen's pixel density. A new
// scale redraws into the same canvas once the old render is cancelled, and the
// previous drawing stays up (stretched) until the new one lands, so zooming
// never flashes white.
function PdfCanvas({ pdf, index, scale, dark }: { pdf: any; index: number; scale: number; dark: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let task: any = null;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const page = await pdf.getPage(index + 1);
        if (!alive || !ref.current) return;
        const dpr = window.devicePixelRatio || 1;
        const vp = page.getViewport({ scale: scale * dpr });
        const off = document.createElement('canvas');
        off.width = Math.floor(vp.width);
        off.height = Math.floor(vp.height);
        task = page.render({ canvasContext: off.getContext('2d'), canvas: off, viewport: vp, pageColors: dark ? PAGE_COLORS : null });
        await task.promise;
        if (!alive || !ref.current) return;
        ref.current.width = off.width;
        ref.current.height = off.height;
        ref.current.getContext('2d')!.drawImage(off, 0, 0);
        setDrawn(true);
      } catch { /* cancelled, or a page pdf.js cannot draw */ }
    }, 60);   // let a fast scroll pass without drawing every page it crosses
    return () => { alive = false; clearTimeout(t); task?.cancel?.(); };
  }, [pdf, index, scale, dark]);
  return (
    <canvas ref={ref} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%',
      opacity: drawn ? 1 : 0, transition: 'opacity 0.25s ease',
    }} />
  );
}
