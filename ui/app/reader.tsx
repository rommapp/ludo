import { ButtonGlyph, Focusable, GamepadButton } from "@ludo/host";
import { FaAdjust, FaBook, FaListUl, FaTimes } from "react-icons/fa";
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { V2 } from "./theme";
import { V2Focus } from "./focus";
import { Bumper, Shimmer } from "./kit";
import { GlassModal, glassBtn, useOncePerPress, usePulse } from "./glass";
import { getRomDocument } from "./rpc";
import { renderMarkdown } from "./markdown";
import { PdfPages, openPdf } from "./pdf";
import { _forceGamepadFocus, playSteamSound } from "./shell";

// Walkthrough reader — a game's guide, read on the couch.
//
// A GameFAQs-style guide is a few hundred KB of 79-column text with its
// sections boxed in rules of === or ---, and it is read with a pad in one hand.
// So the reader is built around the pad rather than a scrollbar: the d-pad
// scrolls (and accelerates when held), left/right jump a section, the bumpers
// page, A opens the section list, X/Y resize the text. The place you stopped
// is remembered per guide, because a walkthrough is read over many sessions.
//
// The d-pad reaches onButtonDown as DIR_* presses (Steam does this natively;
// the desktop host mirrors it), and the reader claims them with
// stopPropagation so they scroll instead of moving focus.

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'heading'; text: string; level: number; sec: number };

const SEP = /^\s*([=\-*~#_+])\1{9,}\s*$/;        // a full rule: =========…
const UNDERLINE = /^\s*(=+|-+)\s*$/;              // setext: a title's underline
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// A heading's display text: whitespace collapsed, and the trailing search code
// GameFAQs guides tag sections with ("[WLK01]") dropped — it exists for Ctrl+F,
// which the reader has no use for.
function tidy(t: string) {
  return t.trim().replace(/\s{2,}/g, ' ').replace(/\s*[\[{(][A-Za-z0-9.\-_ ]{1,12}[\]})]$/, '') || t.trim();
}

// Split a text guide into prose and headings. Three shapes are recognised:
// Markdown `#` headings (Markdown files only — a `#` line in a text guide is
// usually ASCII art), setext titles underlined with === or ---, and the
// GameFAQs box: one short line fenced above and below by a full rule.
export function parseGuide(text: string, markdown: boolean): { blocks: Block[]; sections: string[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const sections: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    // Blank lines at a block's edges would stack on the heading's own margin.
    while (buf.length && !buf[0].trim()) buf.shift();
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length) blocks.push({ kind: 'text', text: buf.join('\n') });
    buf = [];
  };
  const heading = (t: string, level: number) => {
    flush();
    blocks.push({ kind: 'heading', text: t, level, sec: sections.length });
    sections.push(t);
  };
  const blank = (s?: string) => s == null || !s.trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const short = t.length > 0 && t.length <= 80 && !SEP.test(line);
    if (markdown) {
      const m = MD_HEADING.exec(line);
      if (m) { heading(tidy(m[2]), m[1].length); continue; }
    }
    // Boxed: the rule above is the last thing in the buffer; drop both rules.
    if (short && i > 0 && SEP.test(lines[i - 1]) && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      buf.pop();
      heading(tidy(t), 1);
      i++;
      continue;
    }
    // Setext: a title line, then its underline. Needs a blank (or rule) before
    // it, or any paragraph followed by a divider would read as a heading.
    if (short && i + 1 < lines.length && UNDERLINE.test(lines[i + 1]) &&
        lines[i + 1].trim().length >= 3 && (blank(lines[i - 1]) || SEP.test(lines[i - 1] || ''))) {
      heading(tidy(t), lines[i + 1].trim()[0] === '=' ? 1 : 2);
      i++;
      continue;
    }
    buf.push(line);
  }
  flush();
  return { blocks, sections };
}

const HTML_DARK = `
  /* No color-scheme: dark here. When a frame's scheme differs from the page
     around it, Chromium paints the frame an opaque canvas, and the page's
     own translucent background (the text reader's) would be lost. */
  html, body { background: transparent !important; color: ${V2.fg2} !important; }
  body {
    color: ${V2.fg2} !important; font-family: ${V2.font} !important;
    line-height: 1.6 !important; max-width: 62em; margin: 0 auto !important; padding: 18px 22px 40vh !important;
  }
  body *:not(img):not(video):not(svg):not(canvas):not(iframe) {
    background-color: transparent !important; color: inherit !important;
    border-color: ${V2.borderStrong} !important;
  }
  /* :not(#_) lifts these past the catch-all above, which they must beat. */
  :is(h1, h2, h3, h4, h5, h6, b, strong, th):not(#_) { color: ${V2.fg} !important; }
  :is(h1, h2):not(#_) { border-left: 3px solid ${V2.brand} !important; padding-left: 0.6em; }
  :is(a, a *):not(#_) { color: ${V2.brandHover} !important; }
  pre, code, tt { font-family: ui-monospace, "DejaVu Sans Mono", monospace !important; }
  table { border-collapse: collapse; }
  :is(td, th):not(#_) { border: 1px solid ${V2.border} !important; padding: 4px 8px; }
  tr:nth-child(even) td:not(#_) { background-color: rgba(255,255,255,0.03) !important; }
  hr:not(#_) { border: 0 !important; border-top: 1px solid ${V2.borderStrong} !important; }
  img { max-width: 100%; height: auto; border-radius: 4px; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 8px; }
`;

const SIZES = [12, 14, 16, 18, 21, 24, 28];
const SIZE_KEY = 'ludo.reader.fontSize';
const posKey = (romId: number, fileId: number) => `ludo.reader.pos.${romId}.${fileId}`;
// Per PDF: stored only when switched to original colours; dark is the default.
const colorKey = (romId: number, fileId: number) => `ludo.reader.pdfColors.${romId}.${fileId}`;
function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export function DocumentViewer({ romId, file, closeModal }:
  { romId: number; file: any; closeModal?: () => void; }) {
  const [doc, setDoc] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [size, setSize] = useState<number>(() => {
    const v = Number(lsGet(SIZE_KEY));
    return SIZES.includes(v) ? v : 16;
  });
  const [cur, setCur] = useState(-1);          // section the top of the view is in
  const [pct, setPct] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  // Read by back(), which can run from a handler bound before the list opened.
  const tocOpenRef = useRef(false);
  tocOpenRef.current = tocOpen;
  const [htmlSections, setHtmlSections] = useState<string[]>([]);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pdfDark, setPdfDark] = useState(() => lsGet(colorKey(romId, file.id)) !== 'original');
  const toggleColors = () => {
    playSteamSound(pdfDark ? 'deck_ui_switch_toggle_off' : 'deck_ui_switch_toggle_on');
    setPdfDark((d) => {
      lsSet(colorKey(romId, file.id), d ? 'original' : 'dark');
      return !d;
    });
  };
  const [paneW, setPaneW] = useState(0);

  const readerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const tocRows = useRef<(HTMLDivElement | null)[]>([]);
  const repeats = useRef(0);
  const restored = useRef(false);

  useEffect(() => {
    let alive = true;
    getRomDocument(romId, file.id).then((r: any) => {
      if (!alive) return;
      if (r?.success) setDoc(r); else setErr(r?.message || 'Could not open this document');
    }).catch((e: any) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [romId, file.id]);

  // A PDF is opened with pdf.js from the bytes the backend sent.
  useEffect(() => {
    if (doc?.kind !== 'pdf') return;
    let alive = true;
    let opened: any = null;
    (async () => {
      const bin = atob(String(doc.data_uri).split(',')[1] || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      opened = await openPdf(bytes);
      if (alive) setPdfDoc(opened); else opened.pdf.destroy();
    })().catch(() => alive && setErr('Could not open this PDF'));
    return () => { alive = false; opened?.pdf?.destroy?.(); };
  }, [doc]);

  // The pane's width, which a PDF page is fitted to.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneW(el.clientWidth));
    ro.observe(el);
    setPaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const markdown = /\.(md|markdown)$/i.test(file.name || '');
  const title = String(file.name || '').replace(/\.[^.]+$/, '') || file.name;
  // Markdown is rendered; plain text keeps its own layout with headings found.
  // An in-guide "#anchor" link calls jump() through a ref, since jump is
  // defined below and reads the latest layout.
  const jumpRef = useRef<(i: number) => void>(() => {});
  const md = useMemo(
    () => (doc?.kind === 'text' && markdown ? renderMarkdown(doc.text || '', (i) => jumpRef.current(i)) : null),
    [doc, markdown]);
  const parsed = useMemo(
    () => (doc?.kind === 'text' && !markdown ? parseGuide(doc.text || '', false) : null),
    [doc, markdown]);
  const sections: string[] = md ? md.sections : parsed ? parsed.sections
    : pdfDoc ? pdfDoc.sections.map((x: any): string => x.title) : htmlSections;
  // Loaded means ready to show: for a PDF, parsed too, not just downloaded.
  const loaded = !!doc && (doc.kind !== 'pdf' || !!pdfDoc);
  // The skeleton outlives the load by its fade, so the text arrives under it.
  const [skel, setSkel] = useState(true);
  useEffect(() => {
    if (!loaded && !err) return;
    const t = setTimeout(() => setSkel(false), 450);
    return () => clearTimeout(t);
  }, [loaded, err]);

  // The element that scrolls: the text pane, or the HTML document in the
  // frame (same-origin, scripts still off, so the parent can drive it).
  const scroller = (): HTMLElement | null => {
    if (doc?.kind === 'html') {
      const d = frameRef.current?.contentDocument;
      return (d?.scrollingElement as HTMLElement) || null;
    }
    return doc?.kind === 'text' || doc?.kind === 'pdf' ? textRef.current : null;
  };
  const sectionEls = (): HTMLElement[] => {
    if (doc?.kind === 'html') {
      const d = frameRef.current?.contentDocument;
      return d ? Array.from(d.querySelectorAll('h1, h2, h3')) as HTMLElement[] : [];
    }
    return textRef.current ? Array.from(textRef.current.querySelectorAll('[data-sec]')) as HTMLElement[] : [];
  };
  const topOf = (s: HTMLElement, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return doc?.kind === 'html' ? r.top + s.scrollTop : r.top - s.getBoundingClientRect().top + s.scrollTop;
  };
  const maxScroll = (s: HTMLElement) => Math.max(0, s.scrollHeight - s.clientHeight);
  const frac = () => { const s = scroller(); return s && maxScroll(s) ? s.scrollTop / maxScroll(s) : 0; };
  const setFrac = (f: number) => { const s = scroller(); if (s) s.scrollTop = f * maxScroll(s); };

  // Track the section and progress as the view moves, and remember the spot.
  const saveTimer = useRef<any>(null);
  const onScroll = () => {
    const s = scroller();
    if (!s) return;
    const els = sectionEls();
    let c = -1;
    for (let i = 0; i < els.length; i++) {
      if (topOf(s, els[i]) <= s.scrollTop + 8) c = i; else break;
    }
    setCur(c);
    setPct(Math.round(frac() * 100));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => lsSet(posKey(romId, file.id), String(frac())), 300);
  };

  // Restore where the guide was left, once it has laid out.
  const restore = () => {
    if (restored.current) return;
    restored.current = true;
    const f = Number(lsGet(posKey(romId, file.id)));
    if (f > 0 && f <= 1) setFrac(f);
    onScroll();
  };
  useEffect(() => {
    if (doc?.kind !== 'text') return;
    requestAnimationFrame(restore);
  }, [parsed, md]);

  // Text size: keep the reading position across the reflow it causes.
  const keep = useRef<number | null>(null);
  // Header buttons, by name, so a pad press can play the matching button's
  // press animation: the pad never touches the button, and the pulse is what
  // ties "this button shows Y" to "Y does this".
  const { btnRef, pulse } = usePulse();

  const atMin = SIZES.indexOf(size) <= 0;
  const atMax = SIZES.indexOf(size) >= SIZES.length - 1;
  const resize = (d: -1 | 1) => {
    const i = SIZES.indexOf(size) + d;
    const name = d > 0 ? 'bigger' : 'smaller';
    // At the end of the range say so, rather than silently doing nothing.
    if (i < 0 || i >= SIZES.length) { pulse(name, 'nope'); playSteamSound('deck_ui_bumper_end_02'); return; }
    pulse(name);
    playSteamSound(d > 0 ? 'deck_ui_slider_up' : 'deck_ui_slider_down');
    keep.current = frac();
    setSize(SIZES[i]);
    lsSet(SIZE_KEY, String(SIZES[i]));
  };
  useLayoutEffect(() => {
    if (doc?.kind === 'html') {
      const de = frameRef.current?.contentDocument?.documentElement as any;
      if (de) de.style.zoom = String(size / 16);
    }
    if (keep.current != null) { setFrac(keep.current); keep.current = null; }
  }, [size]);

  const onFrameLoad = () => {
    const d = frameRef.current?.contentDocument;
    if (!d) return;
    // Dress the page in the reader's colours. Guides hard-code their own
    // (usually black on white, sometimes per-element), so the override is
    // blunt: every colour is forced, images and media are left alone.
    const st = d.createElement('style');
    st.textContent = HTML_DARK;
    (d.head || d.documentElement).appendChild(st);
    (d.documentElement as any).style.zoom = String(size / 16);
    setHtmlSections(sectionEls().map((h) => tidy(h.textContent || '')).filter(Boolean));
    frameRef.current?.contentWindow?.addEventListener('scroll', onScroll);
    // A click inside the page moves keyboard focus into the frame, where the
    // host's Escape handling never hears it; close from here instead.
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') back(); });
    restore();
  };

  const scrollByPx = (px: number, smooth: boolean) =>
    scroller()?.scrollBy({ top: px, behavior: smooth ? 'smooth' : 'auto' });
  const page = (d: -1 | 1) => { const s = scroller(); if (s) scrollByPx(d * s.clientHeight * 0.9, true); };
  const jump = (i: number) => {
    const s = scroller();
    const el = sectionEls()[i];
    if (s && el) s.scrollTo({ top: topOf(s, el) - 4, behavior: 'smooth' });
  };
  jumpRef.current = jump;
  // Left/right: previous/next section. "Previous" from inside a section goes
  // back to its own start first, as a book's chapter-back does.
  const stepSection = (d: -1 | 1) => {
    const s = scroller();
    const els = sectionEls();
    if (!s || !els.length) { page(d); return; }
    // The end of the guide in that direction: the same bump as a row's end.
    const edge = d > 0 ? cur + 1 >= els.length : (cur <= 0 && s.scrollTop <= 1);
    playSteamSound(edge ? 'deck_ui_bumper_end_02' : 'deck_ui_tile_scroll');
    if (d > 0) { if (!edge) jump(cur + 1); return; }
    if (cur >= 0 && topOf(s, els[cur]) < s.scrollTop - 24) jump(cur);
    else if (cur > 0) jump(cur - 1);
    else s.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openToc = () => {
    if (!sections.length) return;
    playSteamSound('deck_ui_side_menu_fly_in');
    setTocOpen(true);
  };
  // Put the pad on the current section's row once the list has rendered. Not
  // from openToc itself: on Steam the list had not committed yet when that ran,
  // the row did not exist, and focus stayed on the page with nothing in the
  // list selectable. Retried on a short ladder, as useAutoFocus does, for rows
  // Steam registers late.
  useEffect(() => {
    if (!tocOpen) return;
    let placed = false;
    const timers = [0, 60, 160, 320].map((d) => setTimeout(() => {
      const row = tocRows.current[Math.max(0, cur)];
      if (!row) return;
      // The row's own document: on a Deck the plugin's global one is not Big
      // Picture's. Anywhere in the list counts, so a retry never drags the pad
      // back from a row the user already moved to.
      const active = row.ownerDocument?.activeElement;
      if (active && row.parentElement?.contains(active)) return;
      _forceGamepadFocus(row);
      // Centre the row by scrolling the list alone. scrollIntoView would also
      // scroll every container around it, Steam's modal host included, which
      // shifted the whole window until Steam put it back.
      if (!placed) {
        placed = true;
        const list = row.parentElement;
        if (list) list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2;
      }
    }, d));
    return () => timers.forEach(clearTimeout);
  }, [tocOpen]);
  // Back, from anywhere in the reader: closes the section list if it is open,
  // and only otherwise the reader. Every cancel path goes through this because
  // Steam does not stop at the innermost handler: B on a section row also
  // reached the page's handler and the modal's own, and closed the whole
  // reader. (The desktop shell stops at the first, which hid it there.)
  // One press may arrive at several of these handlers; only the first acts, so
  // the list closing cannot be followed by a second handler closing the reader.
  const firstOfPress = useOncePerPress();
  const back = (e?: any) => {
    e?.stopPropagation?.();
    if (!firstOfPress()) return;
    if (tocOpenRef.current) closeToc(); else closeModal?.();
  };
  const closeToc = () => {
    setTocOpen(false);
    setTimeout(() => readerRef.current && _forceGamepadFocus(readerRef.current), 0);
  };

  const onButtonDown = (evt: any) => {
    if (tocOpen) return;   // the list navigates with the d-pad as usual
    const b = evt?.detail?.button;
    const repeat = !!evt?.detail?.is_repeat;
    const line = size * 1.5;
    const claim = () => evt.stopPropagation?.();
    if (b === GamepadButton.DIR_UP || b === GamepadButton.DIR_DOWN) {
      claim();
      repeats.current = repeat ? repeats.current + 1 : 0;
      // Held: speed up the longer it is held, up to ~8 lines a tick.
      const n = repeat ? Math.min(2 + repeats.current / 4, 8) : 4;
      scrollByPx((b === GamepadButton.DIR_DOWN ? 1 : -1) * n * line, !repeat);
    } else if (b === GamepadButton.DIR_LEFT || b === GamepadButton.DIR_RIGHT) {
      claim();
      if (!repeat) stepSection(b === GamepadButton.DIR_RIGHT ? 1 : -1);
    } else if (b === GamepadButton.BUMPER_LEFT || b === GamepadButton.BUMPER_RIGHT) {
      if (repeat) return;
      playSteamSound('deck_ui_tab_transition_01');
      page(b === GamepadButton.BUMPER_RIGHT ? 1 : -1);
    } else if (b === GamepadButton.TRIGGER_LEFT) {
      if (repeat) return;
      playSteamSound('deck_ui_tile_scroll');
      scroller()?.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (b === GamepadButton.TRIGGER_RIGHT) {
      if (repeat) return;
      playSteamSound('deck_ui_tile_scroll');
      const s = scroller(); if (s) s.scrollTo({ top: maxScroll(s), behavior: 'smooth' });
    }
  };

  const ready = loaded && !err;
  const framed = doc?.kind === 'html';
  const pdf = doc?.kind === 'pdf';
  // A PDF zooms rather than resizing text; same steps, 16px being 100%.
  const zoom = size / 16;

  let body: any;
  if (err) body = <div style={{ padding: '24px', color: V2.fgMuted, fontSize: '13px' }}>{err}</div>;
  else if (!loaded) body = null;
  else if (pdf) body = <PdfPages doc={pdfDoc} zoom={zoom} width={paneW} dark={pdfDark} onLaidOut={() => requestAnimationFrame(restore)} />;
  else if (doc.kind === 'html') body = (
    <iframe ref={frameRef} sandbox="allow-same-origin" srcDoc={doc.text} onLoad={onFrameLoad}
      tabIndex={-1} style={{ width: '100%', height: '100%', border: 0, background: 'transparent', animation: 'rdFade 0.4s ease both' }} />
  );
  else if (md) body = (
    <div style={{
      padding: '18px 22px 40vh', maxWidth: '46em', margin: '0 auto', animation: 'rdFade 0.4s ease both',
      fontFamily: V2.font, lineHeight: 1.65,
    }}>{md.node}</div>
  );
  else body = (
    <div style={{ padding: '18px 22px 40vh', maxWidth: '62em', margin: '0 auto', animation: 'rdFade 0.4s ease both' }}>
      {parsed!.blocks.map((b, i) => b.kind === 'heading' ? (
        <div key={i} data-sec={b.sec} style={{
          fontFamily: V2.font, fontWeight: 700, color: V2.fg, letterSpacing: '-0.01em',
          fontSize: `${b.level <= 1 ? 1.35 : b.level === 2 ? 1.15 : 1.05}em`,
          margin: '1.6em 0 0.6em', paddingLeft: b.level <= 1 ? '0.6em' : 0,
          borderLeft: b.level <= 1 ? `3px solid ${V2.brand}` : 'none',
        }}>{b.text}</div>
      ) : (
        <pre key={i} style={{
          margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: 'inherit',
        }}>{b.text}</pre>
      ))}
    </div>
  );

  const hint = (k: string, label: string) => (
    <Loading busy={!loaded}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        <Bumper label={k} /><span>{label}</span>
      </span>
    </Loading>
  );
  // V2Button's tonal look at toolbar height. Plain divs, not Focusables: the
  // page must stay the reader's only focus target, so these are for the mouse
  // and the pad reaches the same actions through A / X / Y.

  return (
    <GlassModal onBack={back} onScrimClick={() => closeModal?.()}>
        {/* Header: title, where you are, and mouse equivalents of the pad keys. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, padding: '2px 2px 0 4px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: V2.radiusMd, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(139,116,232,0.16)', color: V2.brandHover,
          }}><FaBook size={15} /></div>
          <div style={{ minWidth: 0, flex: '1 1 0', overflow: 'hidden' }}>
            <div style={{
              fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              color: V2.fgFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {ready && cur >= 0 && sections[cur] ? sections[cur] : 'Walkthrough'}
            </div>
            <div style={{ color: V2.fg, fontSize: '16px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          </div>
          {/* The real buttons from the first frame, masked by a shimmer of their
              own exact size while loading, so nothing shifts when they appear. */}
          {!err && (<>
            {/* Assumed present while loading. A guide with no sections folds
                it away (width and the flex gap it owns) instead of jumping. */}
            <div style={{
              flexShrink: 0, overflow: 'hidden',
              maxWidth: loaded && !sections.length ? 0 : '160px',
              marginLeft: loaded && !sections.length ? '-12px' : 0,
              opacity: loaded && !sections.length ? 0 : 1,
              transition: 'max-width 0.3s ease, margin-left 0.3s ease, opacity 0.2s ease',
            }}>
              <Loading busy={!loaded}><div ref={btnRef('sections')} className="rd-btn" style={glassBtn} onClick={openToc}><ButtonGlyph slot="ok" /><FaListUl size={11} /> Sections</div></Loading>
            </div>
            {pdf && loaded && (
              <div ref={btnRef('colors')} className="rd-btn" onClick={toggleColors} title={pdfDark ? 'Show original colours' : 'Show dark pages'}
                style={{
                  ...glassBtn, animation: 'rdFade 0.4s ease both',
                  // A light tint, never a white fill: the pad glyph is a white
                  // keycap and vanished against one.
                  background: pdfDark ? V2.surface : 'rgba(255,255,255,0.18)',
                  borderColor: pdfDark ? V2.border : V2.borderStrong,
                  transition: 'background 0.3s ease, border-color 0.3s ease, transform 0.12s ease',
                }}>
                <ButtonGlyph slot="start" />
                {/* Half-filled circle: turns a half-turn per switch, so the lit
                    half swaps sides with the pages. */}
                <FaAdjust size={11} style={{
                  transform: `rotate(${pdfDark ? 0 : 180}deg)`,
                  transition: 'transform 0.4s cubic-bezier(0.22,1,0.36,1)',
                }} />
                {/* Both labels share one grid cell, so the button is as wide as
                    the longer one in either state and never jumps. */}
                <span style={{ display: 'inline-grid' }}>
                  {['Dark', 'Original'].map((l) => {
                    const on = (l === 'Dark') === pdfDark;
                    return (
                      <span key={l} aria-hidden={!on} style={{
                        gridArea: '1 / 1', textAlign: 'left',
                        opacity: on ? 1 : 0, transform: on ? 'none' : `translateY(${l === 'Dark' ? -5 : 5}px)`,
                        transition: 'opacity 0.25s ease, transform 0.3s cubic-bezier(0.22,1,0.36,1)',
                      }}>{l}</span>
                    );
                  })}
                </span>
              </div>
            )}
            <Loading busy={!loaded}><div style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '2px', borderRadius: V2.radiusPill, background: V2.surface, border: `1px solid ${V2.border}` }}>
              <div ref={btnRef('smaller')} className={'rd-btn' + (atMin ? ' rd-off' : '')} style={{ ...glassBtn, height: '26px', minWidth: '30px', padding: '0 8px', background: 'transparent', border: '1px solid transparent', fontSize: '11px' }} onClick={() => resize(-1)}><ButtonGlyph slot="options" />A</div>
              <div ref={btnRef('bigger')} className={'rd-btn' + (atMax ? ' rd-off' : '')} style={{ ...glassBtn, height: '26px', minWidth: '30px', padding: '0 8px', background: 'transparent', border: '1px solid transparent', fontSize: '15px' }} onClick={() => resize(1)}><ButtonGlyph slot="secondary" />A</div>
            </div></Loading>
          </>)}
          <div className="rd-btn" style={{ ...glassBtn, padding: '0 10px' }} onClick={() => closeModal?.()}><ButtonGlyph slot="cancel" /><FaTimes size={12} /></div>
        </div>
        {/* Reading progress: RomM's thin brand track. */}
        {!err && (
          <div style={{ height: '3px', borderRadius: V2.radiusPill, background: V2.surface, overflow: 'hidden', margin: '0 4px' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: V2.brand, borderRadius: V2.radiusPill, transition: 'width 0.15s ease' }} />
          </div>
        )}

        {/* The page. It is the one focus target in the reader, so the pad's
            presses all arrive here. */}
        <Focusable ref={readerRef} autoFocus noFocusRing
          onActivate={(e: any) => { if (!tocOpen && !(e?.detail > 0) && sections.length) { pulse('sections'); openToc(); } }}
          onSecondaryButton={() => resize(1)}
          onOptionsButton={() => resize(-1)}
          onMenuButton={() => { if (pdf && loaded) { pulse('colors'); toggleColors(); } }}
          onButtonDown={onButtonDown}
          onCancelButton={back}
          onOKActionDescription={sections.length ? 'Sections' : undefined}
          onSecondaryActionDescription={pdf ? 'Zoom in' : 'Larger text'}
          onOptionsActionDescription={pdf ? 'Zoom out' : 'Smaller text'}
          style={{
            position: 'relative', flex: 1, minHeight: 0, outline: 'none',
            background: 'rgba(0,0,0,0.28)', border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg,
            overflow: 'hidden',
          }}>
          <div ref={textRef} className="rd-scroll" onScroll={onScroll} style={{
            height: '100%', overflow: framed ? 'hidden' : 'auto',
            fontFamily: 'ui-monospace, "DejaVu Sans Mono", "Cascadia Mono", monospace',
            fontSize: `${size}px`, lineHeight: 1.5, color: V2.fg2,
          }}>{body}</div>

          {skel && (
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
              opacity: doc || err ? 0 : 1, transition: 'opacity 0.4s ease',
            }}><ReaderSkeleton /></div>
          )}

          {/* Section list, over the right edge of the page. */}
          {tocOpen && (
            <Focusable onCancelButton={back} noFocusRing className="rd-scroll" style={{
              position: 'absolute', top: 0, right: 0, bottom: 0, width: '80%', maxWidth: '380px',
              fontFamily: V2.font,
              background: 'linear-gradient(180deg, rgba(22,22,34,0.92) 0%, rgba(12,12,20,0.96) 100%)',
              WebkitBackdropFilter: 'blur(24px)', backdropFilter: 'blur(24px)',
              borderLeft: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '-16px 0 40px rgba(0,0,0,0.5)', overflowY: 'auto',
              padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: '2px',
              animation: 'rdIn 0.16s cubic-bezier(0.22,1,0.36,1)',
            }}>
              <div style={{
                fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                color: V2.fgMuted, padding: '6px 10px 10px',
              }}>Sections · {sections.length}</div>
              <div style={{ height: '1px', background: V2.border, margin: '0 4px 6px', flexShrink: 0 }} />
              {sections.map((s, i) => (
                <TocRow key={i} label={s} current={i === cur}
                  ref={(el: any) => { tocRows.current[i] = el; }}
                  onPick={() => { jump(i); closeToc(); }} />
              ))}
            </Focusable>
          )}
        </Focusable>

        {/* Controls, for the pad. Held in place while loading, so nothing
            below the page moves when the guide lands. */}
        {!err && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 18px', fontSize: '11.5px', color: V2.fgMuted, padding: '0 4px' }}>
            {/* Only what the header cannot show. Its buttons carry their own pad
                glyphs (A / X / Y / B / menu); the d-pad, bumpers and triggers
                have no on-screen control to wear them. */}
            {hint('↑↓', 'Scroll')}
            {hint('←→', !loaded || sections.length ? 'Section' : 'Page')}
            {hint('L1 R1', 'Page')}
            {hint('L2 R2', 'Start / end')}
            <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: V2.fgFaint, opacity: loaded ? 1 : 0, transition: 'opacity 0.35s ease' }}>{pct}%</span>
          </div>
        )}
    </GlassModal>
  );
}

// A control that exists before the guide does: laid out for real from the
// first frame (so its size is final), hidden under a shimmer of that same size
// while busy, then cross-faded in.
function Loading({ busy, children }: { busy: boolean; children: any }) {
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <div style={{ opacity: busy ? 0 : 1, transition: 'opacity 0.35s ease', pointerEvents: busy ? 'none' : undefined }}>{children}</div>
      <Shimmer style={{
        position: 'absolute', inset: 0, borderRadius: V2.radiusPill,
        opacity: busy ? 1 : 0, transition: 'opacity 0.35s ease', pointerEvents: 'none',
      }} />
    </div>
  );
}

// The page while the guide downloads: its real shape greyed out (a heading,
// then paragraphs of ragged lines), fading in late so a fast open never
// flashes it — the same treatment as the home and library skeletons.
function ReaderSkeleton() {
  const paras = [5, 3, 6, 4];
  return (
    <div aria-busy="true" style={{
      padding: '18px 22px', maxWidth: '62em', margin: '0 auto',
      opacity: 0, animation: 'rommSkelIn 0.5s ease 0.15s forwards',
    }}>
      <style>{`
        @keyframes rommShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes rommSkelIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      {paras.map((n, p) => (
        <div key={p} style={{ marginBottom: '26px' }}>
          {p % 2 === 0 && <Shimmer style={{ width: `${34 + p * 6}%`, height: '18px', marginBottom: '16px' }} />}
          {Array.from({ length: n }).map((_, i) => (
            <Shimmer key={i} style={{
              width: i === n - 1 ? `${40 + ((p * 23 + i * 17) % 30)}%` : `${88 + ((p * 7 + i * 13) % 12)}%`,
              height: '11px', marginBottom: '11px',
            }} />
          ))}
        </div>
      ))}
    </div>
  );
}

const TocRow = forwardRef(function TocRow(
  { label, current, onPick }: { label: string; current: boolean; onPick: () => void },
  ref: any,
) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable ref={ref} noFocusRing
      // Stop here: the page around the list is itself activatable (A opens
      // this list), and a pick bubbling up to it reopened the list at once.
      onActivate={(e: any) => { e?.stopPropagation?.(); onPick(); }}
      onClick={(e: any) => { e?.stopPropagation?.(); onPick(); }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{
        borderRadius: V2.radiusMd, cursor: 'pointer',
        // Longhands, not the `border` shorthand: V2Focus.row sets borderColor
        // only while focused, and React does not re-apply a shorthand when that
        // longhand goes away — the border fell back to currentColor and every
        // row the pad passed over kept a white outline.
        borderWidth: '1px', borderStyle: 'solid', fontSize: '13px',
        padding: '9px 12px 9px 14px', position: 'relative', flexShrink: 0,
        color: current ? V2.fg : V2.fg2, fontWeight: current ? 700 : 500,
        background: current ? 'rgba(139,116,232,0.14)' : 'transparent',
        boxSizing: 'border-box',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        ...V2Focus.row(focused),
        // The ring alone marks focus. V2Focus.row also paints the 1px border
        // brand, and at this row's small radius the two drew as separate lines.
        borderColor: 'transparent',
      }}>
      {current && <span style={{ position: 'absolute', left: '4px', top: '9px', bottom: '9px', width: '3px', borderRadius: '3px', background: V2.brand }} />}
      {label}
    </Focusable>
  );
});
