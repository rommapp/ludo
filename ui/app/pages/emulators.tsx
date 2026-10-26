import { cloneElement, useEffect, useRef, useState } from "react";
import { EmulatorBuild, listEmulatorBuilds, setEmulatorBuild } from "../rpc";
import { Focusable, GamepadButton, ModalRoot, showModal } from "@ludo/host";
import { FaCheck, FaChevronLeft, FaChevronRight, FaGamepad, FaSync } from "react-icons/fa";
import { toaster } from "../toast";
import { V2 } from "../theme";
import { V2_FOCUS_STYLE, v2Page } from "../focus";
import { libBack, libNavigate } from "../nav";
import { GameActionButton, MODAL_SCRIM_INSET, UserMenuRow, V2CardRow, V2SettingsSection } from "../kit";
import { _forceGamepadFocus } from "../shell";
import { useEmulatorStatus } from "../emulator";
// Settings ▸ Emulators — every emulator Ludo drives, one row each in the same
// shape: the name, where it lives, and a line about how it was found. A opens
// that emulator's own page (RetroArch/RetroDECK: its cores) or its build choice
// (the standalone ones). A new standalone emulator needs no change here: it
// arrives in the status with its siblings and gets a row.


type BuildSet = { list: EmulatorBuild[]; selected: string; name: string };

// 'flatpak:<id>' is how Ludo stores a Flatpak; say it the way a terminal would,
// as the RetroDECK row already does.
const showPath = (p: string) => (p.startsWith('flatpak:') ? `flatpak run ${p.slice('flatpak:'.length)}` : p);

export function EmulatorsPage() {
  const status = useEmulatorStatus();
  const [builds, setBuilds] = useState<Record<string, BuildSet>>({});
  const keys = (status?.standalone || []).map((e) => e.key).join(',');
  const loadBuilds = () => {
    keys.split(',').filter(Boolean).forEach((key) => {
      listEmulatorBuilds(key)
        .then((r) => {
          if (r?.success) {
            setBuilds((all) => ({ ...all, [key]: {
              list: r.builds || [], selected: r.selected || '', name: r.name || key } }));
          }
        })
        .catch(() => { /* the row keeps its plain subtitle */ });
    });
  };
  useEffect(loadBuilds, [keys]);

  const pickBuild = (key: string) => {
    const set = builds[key];
    if (!set) return;
    showModal(
      <EmulatorBuildModal
        builds={set.list} selected={set.selected} name={set.name}
        onPick={async (path: string) => {
          setBuilds((all) => ({ ...all, [key]: { ...set, selected: path } }));
          try {
            await setEmulatorBuild(key, path);
            toaster.toast({ title: set.name, body: path ? 'Build selected' : 'Back to auto-detect' });
          } catch { loadBuilds(); }
        }} />
    );
  };

  const rows: any[] = [];
  if (status) {
    // RetroArch family first: it runs most of the library.
    rows.push(
      <V2CardRow key="retroarch" icon={<FaGamepad size={15} />} danger={!status.installed}
        title={!status.installed ? 'No emulator found'
          : status.kind === 'retrodeck' ? 'RetroDECK'
            : status.kind === 'flatpak' ? 'RetroArch (Flatpak)'
              : status.kind === 'snap' ? 'RetroArch (Snap)'
                : 'RetroArch'}
        subtitle={status.installed ? (
          <span style={{ wordBreak: 'break-all' }}>
            {status.executable || 'detected'}
            <span style={{ color: V2.fgFaint }}>
              {'  ·  '}{status.core_count
                ? `${status.core_count} core${status.core_count === 1 ? '' : 's'}`
                : 'no cores installed'}
            </span>
          </span>
        ) : 'Install RetroArch or RetroDECK to play these games.'}
        onClick={() => libNavigate('/romm-sync-cores')}
        right={<FaChevronRight size={12} style={{ color: V2.fgFaint }} />} />
    );
    for (const e of status.standalone || []) {
      const set = builds[e.key];
      const chosen = set?.list.find((b) => b.path === set.selected);
      const inUse = chosen?.path || set?.list.find((b) => b.current)?.path || e.executable;
      rows.push(
        <V2CardRow key={e.key} icon={<FaGamepad size={15} />} title={e.name}
          subtitle={e.installed ? (
            <span style={{ wordBreak: 'break-all' }}>
              {showPath(inUse || 'detected')}
              <span style={{ color: V2.fgFaint }}>
                {'  ·  '}{chosen ? 'chosen by you' : 'detected automatically'}
              </span>
            </span>
          ) : 'Not installed'}
          onClick={e.installed && set ? () => pickBuild(e.key) : undefined}
          right={e.installed ? <FaChevronRight size={12} style={{ color: V2.fgFaint }} /> : undefined} />
      );
    }
  }

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-settings")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-settings")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Emulators</div>
      </div>
      <V2SettingsSection title="Installed">
        {/* Hairlines inside one card, first/last told they sit in its rounded
            ends — the shape Settings ▸ Emulator & folders uses. */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          borderRadius: V2.radiusCard, background: V2.surface,
          border: `1px solid ${V2.border}`, overflow: 'hidden',
        }}>
          {rows.map((r, i) => cloneElement(r, {
            divider: i > 0, first: i === 0, last: i === rows.length - 1,
          }))}
        </div>
      </V2SettingsSection>
    </Focusable>
  );
}

// Which build of a standalone emulator to launch, in the same chrome as
// FolderActionsModal — a folder row and this one ask the same shape of
// question, so they answer it the same way rather than inventing a picker.
export function EmulatorBuildModal({ builds, selected, name, onPick, closeModal }: {
  builds: EmulatorBuild[]; selected: string; name: string;
  onPick: (path: string) => void; closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);
  const act = (path: string) => { closeModal?.(); onPick(path); };
  const auto = builds.find((b) => b.current);
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
          position: 'relative', width: '380px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{ padding: '8px 10px 10px', minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1.3 }}>{name}</div>
            <div style={{ fontSize: '11px', color: V2.fgMuted, marginTop: '3px', lineHeight: 1.4 }}>
              {/* The one question anybody actually has before switching. */}
              Every build shares the same saves, firmware and settings.
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          {/* Automatic names the build it resolves to, rather than describing
              the rule and leaving the user to work out which one that is. */}
          <UserMenuRow icon={selected ? <FaSync size={14} /> : <FaCheck size={14} />}
            label={auto ? `Automatic — ${auto.label}` : 'Automatic'}
            onSelect={() => act('')} />
          {builds.map((b) => (
            <UserMenuRow key={b.path}
              icon={selected === b.path ? <FaCheck size={14} /> : <FaGamepad size={14} />}
              label={b.label} onSelect={() => act(b.path)} />
          ))}
          {/* The paths, quietly, under the names they belong to: two AppImages
              called Eden are told apart by where they are. */}
          <div style={{ padding: '4px 12px 8px', fontSize: '10.5px', color: V2.fgFaint, lineHeight: 1.5 }}>
            {builds.map((b) => (
              <div key={b.path} style={{ wordBreak: 'break-all' }}>
                {b.label}: {b.kind === 'flatpak' ? b.path.replace('flatpak:', '') : b.path}
              </div>
            ))}
          </div>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}
