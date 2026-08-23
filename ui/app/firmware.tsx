import { getSwitchFirmwareProgress, installSwitchFirmware, switchPrereqForRom } from "./rpc";
import { Focusable, ModalRoot, showModal, toaster, GamepadButton} from "@ludo/host";
import { useEffect, useRef } from "react";
import { _forceGamepadFocus } from "./shell";
import { V2_FOCUS_STYLE } from "./focus";
import { V2 } from "./theme";
import { FaExclamationTriangle, FaMicrochip } from "react-icons/fa";
import { V2Button, MODAL_SCRIM_INSET} from "./kit";
// Switch firmware and keys, which a Switch rom needs on the device before it
// will boot at all.
//
// This is shared rather than owned by either caller: the BIOS page offers the
// install directly, and a Switch download asks about it first through the gate
// downloads.ts exposes. Both want the same confirm dialog and the same progress
// wording, and neither is the natural owner of the other.

// Starts the detached install and polls it to completion, reporting progress
// as it goes. Returns the final state, so callers still read as "await the
// install" while the RPC socket stays free the whole time.
export async function installSwitchFirmwareWatched(
  onTick?: (p: { phase: string; have: number; total: number; bps: number }) => void,
): Promise<any> {
  const start = await installSwitchFirmware();
  if (!start?.success) return start;
  // Poll a little under a second: the backend recomputes speed on roughly
  // that cadence, so asking faster returns the same numbers.
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    let p: any;
    try { p = await getSwitchFirmwareProgress(); } catch { continue; }
    if (!p) continue;
    onTick?.({ phase: p.phase || '', have: p.have || 0, total: p.total || 0, bps: p.bps || 0 });
    if (!p.active) return p;
  }
}

// Human-readable transfer line: "142 / 325 MB · 8.4 MB/s". Speed is omitted
// until the backend has a sample worth showing rather than printing 0 MB/s.
export function fmtFirmwareProgress(p: { phase: string; have: number; total: number; bps: number }): string {
  if (p.phase === 'installing') return 'Unpacking…';
  if (!p.total) return 'Starting…';
  const mb = (n: number) => (n / 1048576).toFixed(0);
  const speed = p.bps > 0 ? `  ·  ${(p.bps / 1048576).toFixed(1)} MB/s` : '';
  return `${mb(p.have)} / ${mb(p.total)} MB${speed}`;
}

// What actually happened, in the terms someone cares about. "229 file(s)" is
// an implementation detail of how a firmware set is packaged -- what a person
// installed is "the firmware", and separately "the keys".
export function switchInstallSummary(r: any): string {
  const status = r?.status;
  if (status === 'no-emulator') return 'Eden isn’t installed on this device';
  if (status === 'no-firmware') return 'No Switch firmware on the server';
  // Firmware landed but nothing can decrypt it: the fix is an upload, not a
  // retry, so say which.
  if (status === 'no-keys') return 'Firmware installed, but prod.keys is missing — upload it to the Switch platform on RomM';
  if (status === 'installed') {
    const parts: string[] = [];
    if (r.installed) parts.push('Firmware');
    if (r.keys) parts.push('keys');
    return parts.length ? `${parts.join(' and ')} installed` : 'Installed';
  }
  if (status === 'up-to-date') return 'Firmware and keys are already installed';
  return r?.message || 'Install failed';
}

// Getting a Switch game is the moment the firmware actually matters, so the
// prompt belongs here rather than only on the BIOS page, which someone may
// never open. Deliberately not a gate: declining installs no firmware and the
// game still downloads, because a ROM on disk with no firmware is a recoverable
// state and blocking the download would not make it less so.
//
// Once per session. The check is cheap, but a modal in front of every download
// is not something anyone wants twice.
export let _switchPromptDone = false;

export async function maybePromptSwitchFirmware(romId: number): Promise<void> {
  if (_switchPromptDone) return;
  try {
    const info = await switchPrereqForRom(romId);
    if (!info?.needed) return;
    _switchPromptDone = true;
    // Keys missing but no firmware to fetch: nothing to confirm, so say it
    // and move on rather than opening a modal whose only button is Cancel.
    if (!info.available) {
      toaster.toast({
        title: 'Switch firmware',
        body: 'prod.keys is missing — Switch games won’t boot until it’s uploaded to RomM',
      });
      return;
    }
    const mb = info.size ? `${(info.size / 1048576).toFixed(0)} MB` : 'a large download';
    const ok = await new Promise<boolean>((resolve) => {
      showModal(
        <SwitchFirmwareConfirm
          fileName={info.file_name} size={mb} reason={info.reason}
          keysOk={info.keys_ok} version={info.version}
          installedVersion={info.installed_version}
          onAnswer={resolve} />
      );
    });
    if (!ok) return;
    const r = await installSwitchFirmwareWatched();
    toaster.toast({ title: 'Switch firmware', body: switchInstallSummary(r) });
  } catch { /* never let this stop a download */ }
}

// Confirmation for the one transfer big enough to deserve one: ~340 MB into
// another application's system tree. Wears the same chrome as the other
// modals here (scrim, blurred card, V2 tokens, V2Button) rather than raw
// dialog furniture -- and is built from ModalRoot/Focusable/DialogButton
// because @decky/ui's ConfirmModal is exported by neither @decky/ui 4.7.2 nor
// the desktop shim, so importing it would break both builds.
// No `installed` count and no `masterKey` here any more. The count was printed
// as "replacing 238 installed file(s)", a number nobody can judge, and the
// master-key generation says how far prod.keys can decrypt WITHOUT proving it
// covers this firmware — so it could not settle the question being asked. The
// keysOk warning below is the keys fact that changes what you'd do. Both are
// still on the backend payload; this component just stopped rendering them.
export function SwitchFirmwareConfirm({ fileName, size, reason, keysOk,
                                 version, installedVersion, onAnswer, closeModal }: {
  fileName: string; size: string; reason?: string;
  keysOk?: boolean;
  version?: string | null; installedVersion?: string | null;
  onAnswer: (ok: boolean) => void; closeModal?: () => void;
}) {
  // Answer exactly once. Every dismissal route lands here, and a modal that
  // closes without resolving leaves the caller awaiting a promise forever.
  const answered = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const answer = (ok: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(ok);
    closeModal?.();
  };
  useEffect(() => {
    const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);
  return (
    <ModalRoot bHideCloseIcon onCancel={() => answer(false)} onEscKeypress={() => answer(false)}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => answer(false)}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) answer(false); }}
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
        {/* Click-away cancels, like every other modal here. */}
        <div onClick={() => answer(false)} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '420px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '20px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <FaMicrochip size={16} style={{ color: V2.brand, flexShrink: 0 }} />
            {/* The version belongs in the question, since it is the thing
                being decided. Falls back to the generic title only when no
                filename anywhere carried a version to name. */}
            <div style={{ fontSize: '16px', fontWeight: 700, color: V2.fg }}>
              {version ? `Install firmware ${version}?` : 'Install Switch firmware?'}
            </div>
          </div>
          <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.5, marginBottom: '4px' }}>
            {/* One line, and it answers only "what happens to what I have".
                The version being installed is in the title above, so this says
                what it replaces — the fact the decision turns on.

                It used to report the installed FILE COUNT ("replacing 238
                installed file(s)"), which is not something anyone can act on:
                nobody knows whether 238 is the right number, and the version
                they are running is the thing they would actually recognise.
                The count is still there in the panel for anyone who wants it. */}
            {reason === 'missing'
              ? 'Eden has no firmware installed.'
              : installedVersion
                ? `Replaces ${installedVersion}, installed now.`
                // A firmware set is installed but nothing named a version for
                // it — an older marker, or an archive named without one. Say
                // that it gets replaced and stop, rather than reach for the
                // file count to have a number to print.
                : 'Replaces the firmware installed now.'}
          </div>
          <div style={{ fontSize: '13px', color: V2.fgMuted, lineHeight: 1.5, marginBottom: '18px' }}>
            {/* The filename appears only when the title could not name a
                version — then it is the one identifier there is. Alongside
                "Install firmware 20.5.0?" it just restates that, in a worse
                format. */}
            {!version && fileName ? `${fileName} · ` : ''}{size} · goes into Eden’s system directory
          </div>
          {/* Said BEFORE the download, not after it. Firmware without keys
              installs perfectly and then boots nothing, and the only useful
              moment to mention that is while the transfer is still a
              choice. Not a block: installing now and adding keys later is a
              legitimate order to do this in. */}
          {keysOk === false && (
            <div style={{
              display: 'flex', gap: '8px', alignItems: 'flex-start',
              background: 'rgba(251,191,36,0.10)',
              border: `1px solid rgba(251,191,36,0.35)`,
              borderRadius: V2.radiusMd, padding: '10px 12px', marginBottom: '18px',
            }}>
              <FaExclamationTriangle size={13} style={{ color: V2.warning, flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '12px', color: V2.fg2, lineHeight: 1.45 }}>
                No prod.keys found here or on RomM. Eden can’t decrypt firmware
                without it, so games still won’t boot until you upload prod.keys
                to the Switch platform.
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <V2Button variant="text" onClick={() => answer(false)}>Cancel</V2Button>
            <V2Button variant="primary" onClick={() => answer(true)}>Install</V2Button>
          </div>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}
