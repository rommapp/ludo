import { ButtonGlyph, Focusable, GamepadButton } from "@ludo/host";
import { FaChevronLeft, FaChevronRight, FaImages, FaTimes } from "react-icons/fa";
import { useEffect, useRef, useState } from "react";
import { V2 } from "./theme";
import { Bumper, Shimmer } from "./kit";
import { qGetImage } from "./media";
import { GlassModal, glassBtn, useOncePerPress, usePulse } from "./glass";
import { playSteamSound } from "./shell";

// Screenshot viewer — a game's screenshots, one at a time, in the same glass
// modal as the walkthrough reader.
//
// Browsing is the whole job, so every input browses: left/right on the d-pad,
// the bumpers, the on-screen arrows, a swipe on a touchscreen, or a dot in the
// row below. The arrows sit in the stage's side gutters rather than over the
// picture, so they never need to adapt to what is behind them. The shots either
// side of the current one are fetched ahead, so stepping is instant.

// Fetched screenshots, shared across openings: the same few paths are browsed
// back and forth, and each fetch is a full image over the backend bridge.
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
function fetchShot(path: string): Promise<string | null> {
  if (cache.has(path)) return Promise.resolve(cache.get(path)!);
  let p = inflight.get(path);
  if (!p) {
    p = qGetImage(path)
      .then((r: any) => r?.data_uri || null)
      .catch(() => null)
      .then((u: string | null) => { cache.set(path, u); inflight.delete(path); return u; });
    inflight.set(path, p);
  }
  return p;
}

const MAX_DOTS = 20;   // past this the dots stop being countable; the counter is enough

export function ScreenshotViewer({ paths, index, title, closeModal }:
  { paths: string[]; index: number; title?: string; closeModal?: () => void; }) {
  const n = paths.length;
  const multi = n > 1;
  const [i, setI] = useState(index);
  const [uri, setUri] = useState<string | null | undefined>(() => cache.get(paths[index]));
  const { btnRef, pulse } = usePulse();
  const firstOfPress = useOncePerPress();

  useEffect(() => {
    let alive = true;
    const path = paths[i];
    setUri(cache.get(path));
    fetchShot(path).then((u) => { if (alive) setUri(u); });
    // Warm the neighbours, so the next step does not wait on the backend.
    if (multi) {
      fetchShot(paths[(i + 1) % n]);
      fetchShot(paths[(i - 1 + n) % n]);
    }
    return () => { alive = false; };
  }, [i]);

  // `quiet` for A, which the shell already sounds as an activation.
  const go = (d: -1 | 1, quiet = false) => {
    if (!multi) return;
    if (!quiet) playSteamSound('deck_ui_tab_transition_01');
    pulse(d > 0 ? 'next' : 'prev');
    setI((p) => (p + d + n) % n);
  };
  const back = (e?: any) => {
    e?.stopPropagation?.();
    if (firstOfPress()) closeModal?.();
  };

  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (evt?.detail?.is_repeat) {
      // Held: let the d-pad keep stepping, but not the bumpers, which are
      // meant as single flicks.
      if (b !== GamepadButton.DIR_LEFT && b !== GamepadButton.DIR_RIGHT) return;
    }
    if (b === GamepadButton.DIR_LEFT || b === GamepadButton.BUMPER_LEFT) {
      evt.stopPropagation?.();
      go(-1);
    } else if (b === GamepadButton.DIR_RIGHT || b === GamepadButton.BUMPER_RIGHT) {
      evt.stopPropagation?.();
      go(1);
    }
  };

  // Swipe, for the Deck's touchscreen: a mostly-horizontal drag of 50px.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: any) => { if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e: any) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const arrow = (side: 'prev' | 'next'): any => ({
    ...glassBtn, position: 'absolute', top: '50%', marginTop: '-20px',
    [side === 'prev' ? 'left' : 'right']: '12px',
    width: '40px', height: '40px', padding: 0,
    background: 'rgba(255,255,255,0.08)', border: `1px solid ${V2.borderStrong}`,
    WebkitBackdropFilter: 'blur(10px)', backdropFilter: 'blur(10px)',
  });

  return (
    <GlassModal onBack={back} onScrimClick={() => closeModal?.()} panelStyle={{ maxWidth: '1280px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, padding: '2px 2px 0 4px' }}>
        <div style={{
          width: '36px', height: '36px', borderRadius: V2.radiusMd, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(139,116,232,0.16)', color: V2.brandHover,
        }}><FaImages size={15} /></div>
        <div style={{ minWidth: 0, flex: '1 1 0', overflow: 'hidden' }}>
          <div style={{
            fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: V2.fgFaint, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
          }}>{multi ? `Screenshot ${i + 1} of ${n}` : 'Screenshot'}</div>
          <div style={{ color: V2.fg, fontSize: '16px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title || 'Screenshots'}
          </div>
        </div>
        <div className="rd-btn" style={{ ...glassBtn, padding: '0 10px' }} onClick={() => closeModal?.()}>
          <ButtonGlyph slot="cancel" /><FaTimes size={12} />
        </div>
      </div>

      {/* The stage. The one focus target, so the pad's presses land here.
          onActivate is what makes it one: the desktop shell only lets a
          Focusable with an A action take focus, and without it the pad stayed
          on the thumbnail behind the viewer, so L1/R1 paged the game page's
          tabs instead of the screenshots. A steps forward, as in a gallery —
          from the pad only: the shell also runs onActivate on a mouse click
          (which carries a click count in detail), and a click on the picture
          should not page it. */}
      <Focusable autoFocus noFocusRing onActivate={(e: any) => { if (!(e?.detail > 0)) go(1, true); }} onButtonDown={onButtonDown} onCancelButton={back}
        onPointerDown={onPointerDown} onPointerUp={onPointerUp}
        style={{
          position: 'relative', flex: 1, minHeight: 0, outline: 'none', overflow: 'hidden',
          background: 'rgba(0,0,0,0.28)', border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: multi ? '16px 68px' : '16px', boxSizing: 'border-box', touchAction: 'pan-y',
        }}>
        {uri === undefined && (
          <Shimmer style={{
            position: 'absolute', inset: multi ? '16px 68px' : '16px', borderRadius: V2.radiusMd,
            opacity: 0, animation: 'rdFade 0.4s ease 0.15s forwards',
          }} />
        )}
        {uri === null && (
          <div style={{ color: V2.fgMuted, fontSize: '13px' }}>This screenshot could not be loaded.</div>
        )}
        {uri && (
          // Keyed by index so each shot fades in fresh as you step.
          <img key={i} src={uri} draggable={false} style={{
            maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block',
            borderRadius: V2.radiusMd, boxShadow: V2.elev2, userSelect: 'none',
            animation: 'shotIn 0.28s ease both',
          }} />
        )}
        <style>{`@keyframes shotIn { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: none; } }`}</style>
        {multi && (<>
          <div ref={btnRef('prev')} className="rd-btn" style={arrow('prev')} onClick={(e) => { e.stopPropagation(); go(-1); }}><FaChevronLeft size={14} /></div>
          <div ref={btnRef('next')} className="rd-btn" style={arrow('next')} onClick={(e) => { e.stopPropagation(); go(1); }}><FaChevronRight size={14} /></div>
        </>)}
      </Focusable>

      {multi && (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '18px', padding: '0 4px', fontSize: '11.5px', color: V2.fgMuted, minHeight: '20px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Bumper label="←→" /><span>Browse</span></span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Bumper label="L1 R1" /><span>Browse</span></span>
          {n <= MAX_DOTS && (
            // Centred on the panel, not on the gap between the hints and the
            // counter, which sit at uneven widths either side.
            <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {paths.map((_, k) => (
                <div key={k} onClick={() => setI(k)} style={{
                  height: '6px', width: k === i ? '18px' : '6px', borderRadius: V2.radiusPill, cursor: 'pointer',
                  background: k === i ? V2.brand : 'rgba(255,255,255,0.22)',
                  transition: 'width 0.25s cubic-bezier(0.22,1,0.36,1), background 0.25s ease',
                }} />
              ))}
            </div>
          )}
          <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: V2.fgFaint }}>{i + 1} / {n}</span>
        </div>
      )}
    </GlassModal>
  );
}
