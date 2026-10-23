import { Focusable, GamepadButton, ModalRoot, showModal } from "@ludo/host";
import { useEffect, useRef, useState } from "react";
import { FaDownload, FaLayerGroup, FaPuzzlePiece } from "react-icons/fa";
import { V2, fmtBytes } from "./theme";
import { V2_FOCUS_STYLE } from "./focus";
import { MODAL_SCRIM_INSET, PickerModal, V2CardRow, V2Switch } from "./kit";
import { _forceGamepadFocus } from "./shell";
import { toaster } from "./toast";
import { closeEden, getSwitchFetchProgress } from "./rpc";

// ── Choosing a Switch game's update and DLC ─────────────────────────────────
// The two choices behind the game page's Updates & DLC rows. Both write Eden's
// config, which Eden rewrites when it quits, so neither can happen while it is
// open: runEdenChange asks to close it rather than leaving the user to find out.

// What an add-on is called on screen: its file, without the container suffix.
// RomM names every add-on after the base game, and the version number in the
// title metadata is a packed counter nobody reads; the filename is what says
// "2.0.2" or "[Mega Dimension]".
export function addOnLabel(fileName: string): string {
  return String(fileName || '').replace(/\.(nsp|xci|nsz|xcz)$/i, '');
}

// Asks whether to quit Eden. Resolves false on B as well as on "Keep".
function askCloseEden(): Promise<boolean> {
  return new Promise((resolve) => {
    showModal(
      <PickerModal title="Eden is open"
        message="Eden saves its settings when it quits, so it has to close before this can change. A game running in it loses anything not saved."
        onDismiss={() => resolve(false)}
        items={[
          { key: 'close', label: 'Close Eden and apply', danger: true, onSelect: () => resolve(true) },
          { key: 'keep', label: 'Keep Eden open', onSelect: () => resolve(false) },
        ]} />
    );
  });
}

// Runs a change to Eden's settings, closing Eden first if the user agrees, and
// says why when it did not happen. Returns the final status.
export async function runEdenChange(apply: () => Promise<any>): Promise<string> {
  let status = String((await apply())?.status ?? 'failed');
  if (status === 'running') {
    if (!(await askCloseEden())) return status;
    const r = await closeEden();
    if (!r?.closed) {
      toaster.toast({ title: 'Eden is still open', body: 'Close it from its own menu, then try again.' });
      return status;
    }
    status = String((await apply())?.status ?? 'failed');
  }
  if (status === 'no-config') {
    toaster.toast({ title: 'Open Eden once first', body: 'Eden has not created its settings yet.' });
  } else if (status !== 'ok' && status !== 'running') {
    toaster.toast({ title: 'Could not change Eden settings', body: status });
  }
  return status;
}

// How far the add-on download for a game has got, polled while one runs.
// The download can be a 2 GB update, so the row says so rather than sitting
// still for minutes.
export function useFetchProgress(romId: number, active: boolean): any | null {
  const [p, setP] = useState<any | null>(null);
  useEffect(() => {
    if (!active) { setP(null); return; }
    let alive = true;
    const tick = async () => {
      try { const r = await getSwitchFetchProgress(romId); if (alive) setP(r?.file_name ? r : null); }
      catch { /* the next tick asks again */ }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [romId, active]);
  return p;
}

export function fetchLabel(p: any | null): string {
  if (!p) return 'Downloading…';
  return p.state === 'installing' ? 'Installing…' : `Downloading… ${p.percent ?? 0}%`;
}

// The update picker: every update Eden can load, newest first, then the ones
// still on RomM, and the game as released. Eden applies only one, so this is
// a choice, not a set of switches; picking one from RomM downloads it first.
export function openUpdatePicker({ updates, server, choice, onPick, onFetch }: {
  updates: any[]; server: any[]; choice: number | string | null;
  onPick: (c: number | string | null) => void;
  onFetch: (entry: any) => void;
}) {
  showModal(
    <PickerModal title="Update Eden applies" items={[
      ...updates.map((u: any, i: number) => {
        const value = u.mode === 'extcontent' ? u.version : 'nand';
        return {
          key: `${value}:${u.file_name}`,
          label: [addOnLabel(u.file_name), i === 0 ? '(newest)' : '', u.mode !== 'extcontent' ? '· NAND' : '']
            .filter(Boolean).join(' '),
          active: choice === value,
          onSelect: () => onPick(value),
        };
      }),
      ...server.map((e: any) => ({
        key: `server:${e.rom_id}:${e.file_id ?? ''}:${e.file_name}`,
        label: `${addOnLabel(e.file_name)} · download${e.size ? ` ${fmtBytes(e.size)}` : ''}`,
        onSelect: () => onFetch(e),
      })),
      { key: 'none', label: 'Original version (no update)', active: choice === null, onSelect: () => onPick(null) },
    ]} />
  );
}

// The DLC list: one switch per DLC, under one for all of them. A DLC in the
// updates folder turns off on its own; one installed in Eden's NAND can only
// follow the "All DLC" switch, because Eden itself has nothing finer (see
// switch_content.set_file_enabled).
export function SwitchDlcModal({ romId, dlc: installed, server: offered, enabled, onApply, onFetch, closeModal }: {
  romId: number;
  dlc: any[];
  // DLC still on RomM: turning one on downloads it first.
  server: any[];
  // Eden's own "DLC" switch: off means none of them load, whatever the files.
  enabled: boolean;
  onApply: (ids: string[]) => Promise<string>;
  onFetch: (entry: any) => Promise<any>;
  closeModal?: () => void;
}) {
  const [dlc, setDlc] = useState<any[]>(installed);
  const [server, setServer] = useState<any[]>(offered);
  const ids = dlc.map((d) => String(d.title_id));
  const [on, setOn] = useState<Set<string>>(
    () => new Set(enabled ? dlc.filter((d) => d.enabled).map((d) => String(d.title_id)) : []));
  // Refs beside the state: a second press can arrive before React re-renders,
  // and a download that finishes minutes later has to add to what is on now,
  // not to what was on when it started.
  const onRef = useRef(on);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);
  const progress = useFetchProgress(romId, fetching !== null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);

  // A NAND copy has no switch of its own: it loads while Eden's "DLC" switch
  // is on, which it is while any DLC is wanted.
  const nandIds = dlc.filter((d) => !d.toggleable).map((d) => String(d.title_id));
  const apply = async (wanted: Set<string>) => {
    if (busyRef.current) return;
    const next = new Set(wanted);
    if (next.size) nandIds.forEach((id) => next.add(id));
    busyRef.current = true;
    setBusy(true);
    try {
      if (await onApply([...next]) === 'ok') { onRef.current = next; setOn(next); }
    } finally { busyRef.current = false; setBusy(false); }
  };
  const fetchOne = async (e: any) => {
    if (busyRef.current || fetching) return;
    setFetching(e.file_name);
    try {
      const r = await onFetch(e);
      if (r?.status !== 'ok' || !r.title_id) return;
      const id = String(r.title_id);
      setServer((list) => list.filter((x) => x !== e));
      setDlc((list) => [...list.filter((d) => String(d.title_id) !== id),
        { title_id: id, file_name: e.file_name, enabled: true, toggleable: true }]);
      // Downloaded to be played: on, like every other DLC Eden is given.
      await apply(new Set([...onRef.current, id]));
    } finally { setFetching(null); }
  };
  const all = ids.length > 0 && ids.every((id) => on.has(id));
  const toggle = (d: any) => {
    const id = String(d.title_id);
    if (!d.toggleable) {
      toaster.toast({ title: 'Installed in Eden’s NAND',
                      body: 'This DLC can only be turned on and off with All DLC.' });
      return;
    }
    const next = new Set(onRef.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    apply(next);
  };

  const rows = [
    { key: 'all', icon: <FaLayerGroup size={14} />, title: 'All DLC',
      subtitle: `${dlc.filter((d) => on.has(String(d.title_id))).length} of ${dlc.length} active in Eden`,
      onClick: () => apply(all ? new Set() : new Set(ids)),
      right: <V2Switch checked={all} /> },
    ...dlc.map((d) => ({
      key: String(d.title_id), icon: <FaPuzzlePiece size={14} />,
      title: addOnLabel(d.file_name || d.title_id),
      subtitle: [d.title_id, d.toggleable ? '' : 'NAND · follows All DLC'].filter(Boolean).join(' · '),
      onClick: () => toggle(d),
      right: <V2Switch checked={on.has(String(d.title_id))} />,
    })),
    ...server.map((e) => ({
      key: `server:${e.rom_id}:${e.file_id ?? ''}:${e.file_name}`, icon: <FaPuzzlePiece size={14} />,
      title: addOnLabel(e.file_name),
      subtitle: fetching === e.file_name ? fetchLabel(progress)
        : ['On RomM', e.size ? fmtBytes(e.size) : '', 'press to download'].filter(Boolean).join(' · '),
      onClick: () => fetchOne(e),
      right: <FaDownload size={12} style={{ color: V2.fgMuted }} />,
    })),
  ];

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
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
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '460px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '12px',
          display: 'flex', flexDirection: 'column', gap: '10px',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto', opacity: busy && !fetching ? 0.7 : 1,
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '2px 4px 0',
          }}>DLC Eden loads</div>
          <div style={{
            display: 'flex', flexDirection: 'column',
            borderRadius: V2.radiusCard, background: V2.surface,
            border: `1px solid ${V2.border}`, overflow: 'hidden',
          }}>
            {rows.map(({ key, ...r }, i) => (
              <V2CardRow key={key} {...r} first={i === 0} divider={i > 0} last={i === rows.length - 1} />
            ))}
          </div>
          <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.4, padding: '0 4px' }}>
            Eden has one switch for all of a game’s DLC. To turn a single one off, Ludo renames its file so Eden skips it.
          </div>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}
