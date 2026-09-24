import { useEffect, useRef } from "react";
import { ModalRoot } from "@ludo/host";
import { V2 } from "./theme";
import { V2_FOCUS_STYLE } from "./focus";
import { MODAL_SCRIM_INSET } from "./kit";

// The full-size viewer modal — the walkthrough reader and the screenshot
// viewer — in the app's own modal language: a blurred scrim that stops short of
// the button legend, and a glass panel that eases in. Steam's own modal chrome
// is collapsed away (romm-modal-collapse) so only ours shows.
//
// `onBack` is every way out (B, Escape, the modal's own cancel) and must be
// safe to call more than once per press: Steam delivers one B to several
// handlers. A click on the scrim closes too.
export function GlassModal({ onBack, onScrimClick, panelStyle, children }: {
  onBack: (e?: any) => void;
  onScrimClick?: () => void;
  panelStyle?: any;
  children: any;
}) {
  useEffect(() => { openViewers++; return () => { openViewers--; }; }, []);
  return (
    <ModalRoot bHideCloseIcon onCancel={onBack} onEscKeypress={onBack}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <div className="romm-ui" style={{
        position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(7,7,15,0.55)',
        WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
      }}>
        <style>{GLASS_CSS}</style>
        <div onClick={() => (onScrimClick ?? onBack)()} style={{ position: 'absolute', inset: 0 }} />
        <div style={{
          position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px',
          // Width and cap as two plain properties, not min(): the panel must be
          // a fixed size in every host. When it fell back to fitting its
          // content in Steam, a long line of unwrapped text widened the panel.
          height: '84vh', width: '90vw', maxWidth: '1040px', minWidth: 0, flexShrink: 0,
          boxSizing: 'border-box', padding: '16px',
          fontFamily: V2.font, color: V2.fg,
          background: 'linear-gradient(180deg, rgba(20,20,30,0.78) 0%, rgba(10,10,18,0.86) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          animation: 'rdIn 0.18s cubic-bezier(0.22,1,0.36,1)',
          ...panelStyle,
        }}>
          {children}
        </div>
      </div>
    </ModalRoot>
  );
}

// How many viewers are open. Pages behind one check it before acting on their
// own buttons (L1/R1 tab paging, Select, Start): Steam can hand a press to the
// page under a modal as well as to the modal, so the reader's L1 paged the
// guide AND flipped the game page's tab behind it.
let openViewers = 0;
export function viewerOpen(): boolean { return openViewers > 0; }

const GLASS_CSS = `
  ${V2_FOCUS_STYLE}
  .romm-modal-collapse, .romm-modal-collapse > div {
    background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
  }
  @keyframes rdFade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes rdIn { from { opacity: 0; transform: translateY(-6px) scale(0.985); } to { opacity: 1; transform: none; } }
  .rd-btn:hover { background: ${V2.surfaceHover} !important; border-color: ${V2.borderStrong} !important; }
  /* Pressed: a quick dip while held, for mouse and touch. */
  .rd-btn:active { transform: scale(0.94); }
  .rd-btn.rd-off:active { transform: none; }
  .rd-btn.rd-off { opacity: 0.35; cursor: default; }
  .rd-btn.rd-off:hover { background: transparent !important; border-color: transparent !important; }
  .rd-scroll::-webkit-scrollbar { width: 8px; }
  .rd-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 8px; }
  .rd-scroll::-webkit-scrollbar-track { background: transparent; }
`;

// A header button: a tonal pill that dips when pressed. Pair it with
// className="rd-btn" for the hover and press styles.
export const glassBtn: any = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  height: '32px', minWidth: '32px', padding: '0 12px', boxSizing: 'border-box',
  borderRadius: V2.radiusPill, cursor: 'pointer', userSelect: 'none',
  background: V2.surface, border: `1px solid ${V2.border}`, color: V2.fg,
  fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap',
  transition: 'transform 0.12s ease, opacity 0.2s ease',
};

// Named buttons whose press animation a pad shortcut can play: the pad never
// touches the button, and the pulse is what ties "this button shows Y" to "Y
// does this". `nope` is a head-shake for a press that can do nothing.
//
// Played with the Web Animations API, which starts fresh on every call. A
// class-toggle version needed a forced reflow (`void el.offsetWidth`) to replay,
// and the Decky build's minifier deletes that as a no-op read, so there every
// press after the first did nothing.
export function usePulse() {
  const btns = useRef<Record<string, HTMLElement | null>>({});
  const btnRef = (name: string) => (el: HTMLElement | null) => { btns.current[name] = el; };
  const pulse = (name: string, kind: 'press' | 'nope' = 'press') => {
    const el = btns.current[name];
    if (!el?.animate) return;
    if (kind === 'press') {
      el.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(0.9)', offset: 0.35 }, { transform: 'scale(1)' }],
        { duration: 220, easing: 'cubic-bezier(0.22,1,0.36,1)' });
    } else {
      el.animate(
        [0, -3, 3, -2, 2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
        { duration: 320, easing: 'ease' });
    }
  };
  return { btnRef, pulse };
}

// One B press can reach several cancel handlers on Steam; this lets only the
// first of them act.
export function useOncePerPress() {
  const last = useRef(0);
  return () => {
    const now = Date.now();
    if (now - last.current < 120) return false;
    last.current = now;
    return true;
  };
}
