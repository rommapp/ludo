// "Keep mine or keep theirs" for a battery save that changed in two places.
//
// The engine never settles one on its own guess: it parks the conflict, both
// saves untouched, and this prompt is how the user answers. Either
// sync path can raise one: RomM save channels (romm#5198) see it exactly and
// name the device that pushed; older servers' negotiate only knows "RomM".
// Neither choice loses anything: keeping mine leaves the server's save in
// RomM's history, and taking theirs backs this device's file up first.
//
// Asked when it interrupts nothing, the way Steam does: before a launch
// (askSaveConflict, from runLaunch) and when a game has just closed (the
// watcher, for conflicts the engine flags `prompt`). One a background sync
// finds is only toasted by the engine, and asked at the game's next launch.
// B / click-away is "decide later": the conflict stays parked and the save is
// left alone until it's answered.
import { Focusable, GamepadButton, ModalRoot, showModal } from "@ludo/host";
import { useEffect, useRef } from "react";
import { FaCloud, FaDesktop } from "react-icons/fa";
import { V2 } from "./theme";
import { V2_FOCUS_STYLE } from "./focus";
import { _forceGamepadFocus, _gpFocusEl } from "./shell";
import { GameActionButton, MODAL_SCRIM_INSET } from "./kit";
import { getSaveConflicts, resolveSaveConflict } from "./rpc";

export type SaveSide = { updated_at: string; size_bytes?: number; device?: string };
export type SaveConflict = {
  id: string; rom_id: number; game: string; file_name: string;
  prompt?: boolean; local: SaveSide; server: SaveSide;
};
export type ConflictAnswer = 'local' | 'server' | 'later';

// Two saves a minute apart both read "4 min ago"; the gap between them is
// what tells them apart then.
function gap(a: string, b: string): string | null {
  const s = Math.round(Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 1000);
  if (isNaN(s) || when(a) !== when(b)) return null;
  return s < 60 ? `${Math.max(s, 1)} s newer` : `${Math.round(s / 60)} min newer`;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago`
    : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return rel;
}

function Side({ icon, label, side, newer, by }: { icon: any; label: string; side: SaveSide; newer: boolean; by?: string | null }) {
  return (
    <div style={{
      flex: 1, minWidth: 0, padding: '12px', borderRadius: V2.radiusMd,
      background: V2.surface, border: `1px solid ${newer ? 'rgba(139,116,232,0.55)' : V2.border}`,
      display: 'flex', flexDirection: 'column', gap: '6px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
        {icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {newer && <span style={{
          marginLeft: 'auto', fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          color: V2.brand, background: 'rgba(139,116,232,0.14)', borderRadius: V2.radiusChip, padding: '2px 6px',
        }}>Newer</span>}
      </div>
      <div style={{ fontSize: '12.5px', color: V2.fg2 }}>{when(side.updated_at)}{newer && by ? ` · ${by}` : ''}</div>
    </div>
  );
}

export function SaveConflictPrompt({ conflict, onAnswer, closeModal }: {
  conflict: SaveConflict; onAnswer: (a: ConflictAnswer) => void; closeModal?: () => void;
}) {
  const answered = useRef(false);
  const primaryRef = useRef<any>(null);
  const panelRef = useRef<any>(null);
  const answer = (a: ConflictAnswer) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(a);
    closeModal?.();
  };
  // Opened by the watcher rather than a button press, the prompt can land
  // while Home is still settling its own focus, which then takes it back and
  // leaves the prompt reachable by mouse only. Re-claim it a few times until
  // it sticks.
  useEffect(() => {
    const ts = [60, 250, 600, 1200].map((ms) => setTimeout(() => {
      const panel = panelRef.current;
      const cur = _gpFocusEl();
      if (panel && cur && panel.contains?.(cur)) return;
      const el = primaryRef.current || panel;
      if (el) _forceGamepadFocus(el);
    }, ms));
    return () => ts.forEach(clearTimeout);
  }, []);

  const other = conflict.server.device || 'RomM';
  const serverNewer = new Date(conflict.server.updated_at) > new Date(conflict.local.updated_at);
  const by = gap(conflict.local.updated_at, conflict.server.updated_at);

  return (
    <ModalRoot bHideCloseIcon onCancel={() => answer('later')} onEscKeypress={() => answer('later')}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => answer('later')}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) answer('later'); }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
        `}</style>
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          fontFamily: V2.font, color: V2.fg, width: '500px', maxWidth: '90vw', boxSizing: 'border-box',
          padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px',
          maxHeight: '82vh', overflowY: 'auto',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
        }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.brand }}>
              Save conflict
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '4px' }}>{conflict.game}</div>
            <div style={{ fontSize: '13px', color: V2.fg2, marginTop: '4px' }}>
              Changed here and on {other} since they last matched. Either way, the other save is kept.
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <Side icon={<FaDesktop size={13} />} label="This device" side={conflict.local} newer={!serverNewer} by={by} />
            <Side icon={<FaCloud size={13} />} label={other} side={conflict.server} newer={serverNewer} by={by} />
          </div>


          <Focusable flow-children="horizontal" style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
            <GameActionButton icon={<FaDesktop size={13} />} label="Keep mine"
              variant="surface" focusRef={serverNewer ? undefined : primaryRef}
              onClick={() => answer('local')} />
            <GameActionButton icon={<FaCloud size={13} />} label={`Use ${other}'s`}
              variant="surface" focusRef={serverNewer ? primaryRef : undefined}
              onClick={() => answer('server')} />
          </Focusable>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// One prompt at a time; a conflict answered "later" isn't asked again this
// session, so the engine's queue can keep it without the prompt nagging.
// Held on globalThis so a second copy of this module (a hot reload in dev)
// shares it: otherwise the old copy's watcher stacks its own prompt over a
// launch's, the answer goes to that one, and the launch never resumes.
const _shared: { deferred: Set<string>; open: boolean } =
  ((globalThis as any).__ludoSaveConflict ??= { deferred: new Set<string>(), open: false });
const _deferred = _shared.deferred;

export function askSaveConflict(conflict: SaveConflict): Promise<ConflictAnswer> {
  _shared.open = true;
  return new Promise((resolve) => {
    showModal(<SaveConflictPrompt conflict={conflict} onAnswer={(a) => {
      _shared.open = false;
      if (a === 'later') _deferred.add(conflict.id);
      resolve(a);
    }} />);
  });
}

async function pollOnce() {
  if (_shared.open) return;
  let list: SaveConflict[] = [];
  try { list = (await getSaveConflicts()) || []; } catch { return; }
  const next = list.find((c) => c.prompt && !_deferred.has(c.id));
  if (!next || _shared.open) return;
  const a = await askSaveConflict(next);
  if (a !== 'later') resolveSaveConflict(next.id, a).catch(() => { });
}

// The first look waits a little: a conflict found by the startup sync would
// otherwise open over Home's loading skeleton, before there's a page behind it.
export function watchSaveConflicts(intervalMs = 4000, firstMs = 8000): () => void {
  let t: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => { pollOnce(); t = setInterval(pollOnce, intervalMs); }, firstMs);
  return () => { clearTimeout(first); if (t) clearInterval(t); };
}
