import { cloneElement, useEffect, useRef, useState } from "react";
import { EmulatorBuild, finishOnboarding, getConfig, getRommLogo, getSteamTileStatus, listEmulatorBuilds, pairDevice, repairEmulatorPaths, saveConfig, setDeviceNameRpc, setEmulatorBuild, setLibraryPaths, setSteamTile, testRommConnection } from "../rpc";
import { FileSelectionType, Focusable, Navigation, host, openFilePicker, showModal, toaster, ModalRoot, GamepadButton} from "@ludo/host";
import { V2 } from "../theme";
import { FaBoxOpen, FaCheck, FaCheckCircle, FaChevronLeft, FaChevronRight, FaDownload, FaExternalLinkAlt, FaGamepad, FaPlay, FaPuzzlePiece, FaSave, FaSync, FaTimes, FaUndo} from "react-icons/fa";
import { libNavigate } from "../nav";
import { Bumper, GameActionButton, PairCodeField, V2Segment, V2SettingsRow, V2SettingsSection, V2Switch, V2TextField, UserMenuRow, MODAL_SCRIM_INSET, ScrollFade, V2CardRow} from "../kit";
import { _forceGamepadFocus, playSteamSound, useAutoFocus } from "../shell";
import { V2Bg } from "../media";
import { V2_FOCUS_STYLE } from "../focus";
import { QrCode, pickerStart, useQrPairing } from "../pairing";
import { EmuStalePath, InstallProgressBar, PlatformSyncList, installSize, loadEmulatorStatus, publishEmulatorStatus, startEmulatorInstall, useEmulatorInstall, useEmulatorStatus, usePlatformSync, setWizardOpen} from "../emulator";
// First run: welcome, connect, folders, done.
//
// Opened automatically when nothing is configured, and reachable afterwards
// from the QAM. It is full-screen and linear on purpose — the Deck's on-screen
// keyboard covers half the display, so a form that scrolls under it is much
// worse than one step at a time.

// Settings ▸ Folders — where ROMs, saves and BIOS files actually live, which
// until now was only visible inside the setup wizard. Each row shows the path in
// use and whether it was set by the user or detected; A opens the folder picker.
// Stale-path warnings live here too, next to the folders they're about.
// Connect-step routes, in the order the bumpers cycle them.
type WizMode = 'qr' | 'pair' | 'login';

export function FoldersSection() {
  const status = useEmulatorStatus();
  const [busy, setBusy] = useState<string | null>(null);
  // Standalone emulator builds — Eden ships a stable and a nightly AppImage
  // side by side, and both match the same discovery rule. Asked once per mount:
  // the answer is a filesystem scan that changes when the user installs
  // something, not while they are looking at this page.
  const [builds, setBuilds] = useState<{ list: EmulatorBuild[]; selected: string; name: string }>(
    { list: [], selected: '', name: 'Eden' });
  const loadBuilds = () => {
    listEmulatorBuilds('eden')
      .then((r) => {
        if (r?.success) {
          setBuilds({
            list: r.builds || [], selected: r.selected || '',
            // The emulator's own name, from STANDALONE_EMULATORS. "Switch
            // emulator" described the slot; the row sits in a card that already
            // names what Ludo found, and naming the thing is what the rows
            // around it do.
            name: r.name || 'Eden',
          });
        }
      })
      .catch(() => { /* the row simply doesn't appear */ });
  };
  useEffect(loadBuilds, []);
  if (!status) return null;

  const cfg = status.configured_paths || {};
  const defaults = status.default_paths || {};
  const stale = status.stale_paths || [];
  const staleFor = (kind: string) => stale.find((p) => p.kind === kind);

  // Shown when the user has set nothing. What's on disk first, then where the
  // emulator WILL keep it: a freshly installed emulator has created neither its
  // saves nor its system folder, and "Not set" was a worse answer than the
  // correct path. A ROM folder is ours to choose, so it has no detected value.
  const expected = status.expected_paths || {};
  const detected: Record<string, string> = {
    saves: status.save_dirs?.saves || expected.saves || '',
    bios: status.bios_dir || expected.bios || '',
  };

  const write = async (kind: string, value: string) => {
    setBusy(kind);
    try {
      const r = await setLibraryPaths(
        kind === 'roms' ? value : undefined,
        kind === 'saves' ? value : undefined,
        kind === 'bios' ? value : undefined,
        kind === 'exe' ? value : undefined);
      if (r?.success) {
        // The reply IS a fresh emulator_status, so the rows (and any stale
        // warning that just cleared) update without a second round-trip.
        publishEmulatorStatus({
          ...status,
          installed: !!r.installed, kind: r.kind || status.kind,
          executable: r.executable || null, cores_dir: r.cores_dir || null,
          core_count: r.core_count ?? status.core_count,
          stale_paths: r.stale_paths || [], save_dirs: r.save_dirs || {},
          standalone: r.standalone || status.standalone || [],
          bios_dir: r.bios_dir || '', configured_paths: r.configured_paths || {},
          default_paths: r.default_paths || status.default_paths || {},
          expected_paths: r.expected_paths || status.expected_paths || {},
        });
        toaster.toast({ title: 'Folders', body: value ? 'Folder updated' : 'Back to auto-detect' });
      } else {
        toaster.toast({ title: 'Folders', body: r?.message || 'Could not save that folder' });
      }
    } catch { toaster.toast({ title: 'Folders', body: 'Could not save that folder' }); }
    finally { setBusy(null); }
  };

  const pick = async (kind: string, current: string) => {
    try {
      const res = await openFilePicker(
        FileSelectionType.FOLDER, pickerStart(current), false, true);
      if (res?.realpath) await write(kind, res.realpath);
    } catch { /* the user dismissed the picker */ }
  };

  const fixStale = async (p: EmuStalePath) => {
    setBusy(p.kind);
    try {
      const r = await repairEmulatorPaths([`${p.section}.${p.key}`]);
      if (r?.success) {
        await loadEmulatorStatus(true);
        if (!r.repaired?.length) {
          toaster.toast({ title: 'Folders', body: 'Nothing to change here' });
        }
      } else toaster.toast({ title: 'Folders', body: r?.message || 'Could not update' });
    } catch { toaster.toast({ title: 'Folders', body: 'Could not update' }); }
    finally { setBusy(null); }
  };

  // A on a row opens the actions menu (choose / back to default) rather than the
  // picker directly — see FolderActionsModal.
  const openActions = (kind: string, label: string, inUse: string) => {
    const def = defaults[kind] ?? '';
    const configured = cfg[kind] || '';
    showModal(
      <FolderActionsModal
        label={label} current={inUse} def={def}
        // Already default when nothing is configured, or when what IS configured
        // is exactly what we would have chosen anyway.
        isDefault={!configured || configured === def}
        onChoose={() => void pick(kind, inUse)}
        onReset={() => void write(kind, def)} />
    );
  };

  const row = (kind: string, label: string, icon: any, hint: string) => {
    const configured = cfg[kind] || '';
    const inUse = configured || detected[kind] || '';
    const bad = staleFor(kind);
    return (
      <V2CardRow key={kind} icon={icon} danger={!!bad} title={label}
        subtitle={busy === kind ? 'Saving…' : bad ? (
          <span>
            {bad.reason} · <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{bad.value}</span>
            {' → '}<span style={{ color: V2.fg2 }}>{bad.suggested || 'auto-detect'}</span>
            {kind === 'bios' ? (
              // Fix redirects where BIOS files GO; it moves nothing. Saying so
              // matters when the old folder holds thousands of them.
              <span> · A sends new BIOS files to your emulator instead. Files
                already in that folder stay where they are.</span>
            ) : ' · A to fix'}
          </span>
        ) : (
          <span style={{ wordBreak: 'break-all' }}>
            {inUse || 'Not set'}
            <span style={{ color: V2.fgFaint }}>
              {'  ·  '}{configured ? hint
                : inUse ? 'detected automatically'
                  // Nothing set and nothing detected. "set by you" was plainly
                  // wrong here — it read "Not set · set by you" — and so was
                  // implying a problem: the BIOS folder is legitimately empty
                  // until the emulator's own one is known.
                  : 'Ludo will use your emulator\u2019s own folder'}
            </span>
          </span>
        )}
        onClick={busy ? undefined : () => (bad ? fixStale(bad) : openActions(kind, label, inUse))}
        right={bad
          ? <span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>Fix</span>
          : <FaChevronRight size={12} style={{ color: V2.fgFaint }} />} />
    );
  };

  // The emulator override is not a folder and has no picker — it only ever needs
  // clearing, which hands detection back to Ludo.
  const exeStale = staleFor('exe');
  const exeOverride = cfg.exe || '';

  // What Ludo actually found. Everything below it is derived from this, so it
  // reads first: a wrong answer here explains a wrong answer in every row.
  // kind is retrodeck | flatpak | snap | native — the last three are all
  // RetroArch, so name the flavour rather than dropping it.
  const emuRow = (
    <V2CardRow key="emu" icon={<FaGamepad size={15} />} danger={!status.installed}
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

  // Which Eden build Play uses. A row here rather than a section of its own in
  // Settings: this is the same question as "which emulator did you find and
  // where does it live", and it belongs in the card that answers it. Only when
  // there is a choice — one install is not a decision, and a permanent row
  // saying "Eden" is furniture to scroll past on a Deck.
  const chosenBuild = builds.list.find((b) => b.path === builds.selected);
  const autoBuild = builds.list.find((b) => b.current);
  const buildRow = builds.list.length > 1 ? (
    <V2CardRow key="build" icon={<FaGamepad size={15} />} title={builds.name}
      subtitle={
        <span style={{ wordBreak: 'break-all' }}>
          {chosenBuild ? chosenBuild.label : autoBuild ? autoBuild.label : 'Automatic'}
          <span style={{ color: V2.fgFaint }}>
            {'  ·  '}{chosenBuild ? 'chosen by you' : 'detected automatically'}
          </span>
        </span>
      }
      onClick={() => showModal(
        <EmulatorBuildModal
          builds={builds.list} selected={builds.selected} name={builds.name}
          onPick={async (path: string) => {
            setBuilds((b) => ({ ...b, selected: path }));
            try {
              await setEmulatorBuild('eden', path);
              toaster.toast({ title: builds.name,
                body: path ? 'Build selected' : 'Back to auto-detect' });
            } catch { loadBuilds(); }
          }} />
      )}
      right={<FaChevronRight size={12} style={{ color: V2.fgFaint }} />} />
  ) : null;

  const rows = [
    emuRow,
    buildRow,
    row('roms', 'ROM folder', <FaBoxOpen size={15} />, 'set by you'),
    row('saves', 'Save folder', <FaSave size={15} />, 'set by you'),
    row('bios', 'BIOS folder', <FaPuzzlePiece size={15} />, 'set by you'),
    (exeOverride || exeStale) ? (
      <V2CardRow key="exe" icon={<FaGamepad size={15} />} danger={!!exeStale}
        title="Emulator path"
        subtitle={busy === 'exe' ? 'Saving…' : exeStale
          ? `${exeStale.reason} · ${exeStale.value} · A to clear and auto-detect`
          : `${exeOverride}  ·  overriding auto-detection — A to clear`}
        onClick={busy ? undefined : () => (exeStale ? fixStale(exeStale) : write('exe', ''))}
        right={<span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>
          {exeStale ? 'Fix' : 'Clear'}</span>} />
    ) : null,
    stale.length > 1 ? (
      <V2CardRow key="all" icon={<FaCheck size={15} />}
        title={busy === 'all' ? 'Fixing all…' : 'Fix all'}
        subtitle={`Point all ${stale.length} back at your emulator.`}
        onClick={busy ? undefined : async () => {
          setBusy('all');
          try {
            const r = await repairEmulatorPaths();
            if (r?.success) await loadEmulatorStatus(true);
          } finally { setBusy(null); }
        }} />
    ) : null,
  ].filter(Boolean) as any[];

  return (
    <V2SettingsSection title="Emulator & folders">
      {/* One card, not one per folder: these are a single answer to "what did
          Ludo find and where does my library live", and reading them as a block
          is the point. Hairlines instead of gaps, and the first/last rows are
          told they sit in the card's rounded ends so the focus ring can follow
          them. Which row is last depends on the conditional ones, hence the
          clone rather than props at each call site. */}
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
  );
}
// Per-folder actions, in the account-menu chrome. A on a folder row opens this
// rather than jumping straight into the picker: choosing a folder is only half
// of what people want to do with one, and "back to the default" needs to say
// what the default IS before you commit to it.
function FolderActionsModal({ label, current, def, isDefault, onChoose, onReset, closeModal }:
  {
    label: string; current: string; def: string; isDefault: boolean;
    onChoose: () => void; onReset: () => void; closeModal?: () => void;
  }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);
  const act = (f: () => void) => { closeModal?.(); f(); };
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
            <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1.3 }}>{label}</div>
            <div style={{
              fontSize: '11px', color: V2.fgMuted, marginTop: '3px', wordBreak: 'break-all',
            }}>{current || 'Not set'}</div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow icon={<FaBoxOpen size={14} />} label="Choose a folder…"
            onSelect={() => act(onChoose)} />
          {/* Only when it would actually change something — a reset that is a
              no-op is noise, and worse, it implies the current value is wrong. */}
          {!isDefault && (
            <UserMenuRow icon={<FaUndo size={14} />}
              label={def ? 'Use the default folder' : 'Back to auto-detect'}
              onSelect={() => act(onReset)} />
          )}
          {!isDefault && def && (
            <div style={{
              padding: '2px 12px 8px', fontSize: '10.5px', color: V2.fgFaint,
              wordBreak: 'break-all',
            }}>{def}</div>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Which build of a standalone emulator to launch, in the same chrome as
// FolderActionsModal — a folder row and this one ask the same shape of
// question, so they answer it the same way rather than inventing a picker.
function EmulatorBuildModal({ builds, selected, name, onPick, closeModal }: {
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

const WIZ_MODES: WizMode[] = ['qr', 'pair', 'login'];


export function SetupWizard() {
  const [step, setStep] = useState(0);
  // 'qr' leads because it is the only route that asks for nothing but the URL —
  // the other two still cost a trip through the on-screen keyboard, and both
  // stay available for servers too old for device auth (or users without a
  // phone to hand).
  const [mode, setMode] = useState<WizMode>('qr');
  const [logo, setLogo] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [romDir, setRomDir] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [biosDir, setBiosDir] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [deviceNameDefault, setDeviceNameDefault] = useState('SteamOS');
  const [hasPassword, setHasPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  // Pairing happens when LEAVING the Connect step, not at Finish. A pairing code
  // is short-lived, and anyone who stopped to install RetroArch or pick folders
  // was spending that life on the rest of the wizard — arriving at Finish to
  // "Invalid or expired pairing code" with the code long gone from the server's
  // screen. Redeeming it while the user is still looking at it also means the
  // error lands on the field that caused it.
  const [paired, setPaired] = useState(false);
  const [pairing, setPairing] = useState(false);
  // Desktop-only opt-in on the final step: write a "Ludo" tile into Steam's
  // shortcuts.vdf. Offered here rather than as its own step because it's
  // optional system integration, not something sync needs — and it mirrors what
  // doFinish already does unconditionally on the Deck (addRommShortcut, where
  // the tile is mandatory because Play routes through it). Only shown when Steam
  // is actually installed; applied in doFinish so backing out changes nothing.
  const [tileAvailable, setTileAvailable] = useState(false);
  const [wantTile, setWantTile] = useState(true);
  const [busy, setBusy] = useState(false);
  // Emulator step — offered BEFORE Folders, because with nothing installed the
  // folder defaults are Ludo's own fallbacks: the save dir would be one
  // RetroArch never reads, and the BIOS field comes back blank (there is no
  // system/ dir to detect). Installing first means the folders step is seeded
  // from a real emulator instead.
  const emu = useEmulatorStatus();
  const emuInstall = useEmulatorInstall();
  // Whether the wizard has an Emulator step at all, decided ONCE from the first
  // status we see and then frozen. It must not depend on the live `installed`
  // flag: installing from inside the step would drop the step out from under
  // the user mid-install, shifting every index after it.
  const [hasEmuStep, setHasEmuStep] = useState<boolean | null>(null);
  useEffect(() => {
    if (emu && hasEmuStep === null) setHasEmuStep(!emu.installed);
  }, [emu, hasEmuStep]);
  // Platforms step — optional, and only offered when the choice is worth making.
  // A three-platform, 200-game server has nothing to gain from it, and a step
  // whose honest answer is always "leave it alone" is a step that teaches people
  // to click through steps. Frozen like hasEmuStep, and only ever decided while
  // the user is still on or before Folders: inserting a step at the index the
  // user is currently standing on would swap the page out from under them.
  const platformSync = usePlatformSync();
  const [hasPlatformStep, setHasPlatformStep] = useState<boolean | null>(null);
  // Set once the re-read that runs after the connection exists has been asked
  // for. The hook's own load fires at mount, when there is no server to ask.
  const platformProbed = useRef(false);

  // Silences the install's own toasts for as long as this screen owns them.
  useEffect(() => {
    setWizardOpen(true);
    return () => setWizardOpen(false);
  }, []);
  // Extra bottom scroll room, added ONLY while a field is focused (keyboard up),
  // so the resting layout stays vertically centered with normal top spacing and
  // a focused field can still scroll clear of the keyboard overlay. Turning it
  // OFF is debounced: hopping from one field straight to another fires
  // blur(false) then activate(true), and collapsing the padding in between
  // would yank the scroll position around.
  // Landing focus per step: Connect highlights the RomM URL field (mode already
  // defaults to pair-code); the final step highlights Finish & open library.
  // Steps are addressed by name, not by index: the Emulator step is conditional,
  // so every `step === 2` in here would otherwise mean a different page
  // depending on what is installed.
  const STEPS = ['welcome', 'connect', ...(hasEmuStep ? ['emulator'] : []), 'folders',
    ...(hasPlatformStep ? ['platforms'] : []), 'ready'];
  const TOTAL = STEPS.length;
  const cur = STEPS[Math.min(step, TOTAL - 1)];
  const startFocusRef = useAutoFocus(cur === 'welcome', step);
  const urlFocusRef = useAutoFocus(cur === 'connect', step);
  const emuNextRef = useAutoFocus(cur === 'emulator', step);
  const foldersNextRef = useAutoFocus(cur === 'folders', step);
  const platformsNextRef = useAutoFocus(cur === 'platforms', step);
  const finishFocusRef = useAutoFocus(cur === 'ready', step);

  // Decide whether the Platforms step exists, and freeze it. Runs only while the
  // user is on Folders — the step lands immediately after it, so inserting it
  // here shifts nothing the user is currently looking at.
  useEffect(() => {
    if (cur !== 'folders' || hasPlatformStep !== null) return;
    if (!platformProbed.current) {
      // The connection is live by now, unlike at mount. Ask again.
      platformProbed.current = true;
      platformSync.reload();
      return;
    }
    if (platformSync.loading) return;
    setHasPlatformStep(
      platformSync.connected
      && platformSync.rows.length >= 5
      && platformSync.totalRoms >= 1500);
  }, [cur, hasPlatformStep, platformSync.loading, platformSync.rows,
      platformSync.connected]);
  const [kbRoom, _setKbRoomRaw] = useState(false);
  const kbOffTimer = useRef<any>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  // Scroll position at rest, captured when the keyboard room first opens, so
  // collapsing the keyboard restores the page to where the user left it instead
  // of staying scrolled down at wherever the focused field was lifted to.
  const kbRestScroll = useRef(0);
  const collapseKbRoom = () => {
    _setKbRoomRaw(false);
    // After the padding collapses (next frame), glide back to the resting
    // position — clamped implicitly by the now-shorter scroll range.
    requestAnimationFrame(() => {
      try { scrollHostRef.current?.scrollTo({ top: kbRestScroll.current, behavior: 'smooth' }); } catch { }
    });
  };
  const setKbRoom = (open: boolean) => {
    if (kbOffTimer.current) { clearTimeout(kbOffTimer.current); kbOffTimer.current = null; }
    if (open) {
      _setKbRoomRaw((was) => {
        if (!was) kbRestScroll.current = scrollHostRef.current?.scrollTop ?? 0;
        return true;
      });
    } else {
      kbOffTimer.current = setTimeout(collapseKbRoom, 450);
    }
  };
  // The keyboard manager's open flag — not field events — is the source of
  // truth for the room, in BOTH directions:
  //  - close: dismissing with B keeps gamepad focus on the same field, so
  //    onBlur never fires and the page stayed scrolled down.
  //  - open: after a keyboard session, gamepad focus sits on the INNER input,
  //    so the next A press reopens the keyboard via Steam itself and the
  //    wrapper's onActivate (our onKb(true)) never runs — the room stayed
  //    closed until the user moved to a different field.
  // So poll the flag while the wizard is mounted and reconcile the room to it.
  const kbRoomRef = useRef(false);
  useEffect(() => { kbRoomRef.current = kbRoom; }, [kbRoom]);
  useEffect(() => {
    const openRoom = (doc: any) => {
      if (!kbRoomRef.current) kbRestScroll.current = scrollHostRef.current?.scrollTop ?? 0;
      _setKbRoomRaw(true);
      // Lift whichever field owns the keyboard clear of it.
      [120, 600].forEach((d) => setTimeout(() => {
        try {
          const wrap = doc?.activeElement?.closest?.('.wiz-field');
          if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch { /* ignore */ }
      }, d));
    };
    let last: boolean | null = null;
    const iv = setInterval(() => {
      try {
        const open = host.keyboard.isOpen();
        if (last === null) { last = open; return; }
        if (open && !kbRoomRef.current) openRoom(host.uiDocument());
        if (open === last) return;
        last = open;
        if (!open && kbRoomRef.current) {
          if (kbOffTimer.current) { clearTimeout(kbOffTimer.current); kbOffTimer.current = null; }
          collapseKbRoom();
        }
      } catch { /* ignore */ }
    }, 250);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const c = await getConfig();
        setUrl(c.url || ''); setUsername(c.username || '');
        setRomDir(c.rom_directory || ''); setSaveDir(c.save_directory || ''); setBiosDir(c.bios_directory || '');
        setDeviceName(c.device_name || ''); setDeviceNameDefault(c.device_name_default || 'SteamOS');
        setHasPassword(c.has_password || false);
      } catch { /* ignore */ }
      try { const l = await getRommLogo(); setLogo(l?.data_uri || null); } catch { /* ignore */ }
      if (host.capabilities.shortcutTile) {
        try {
          const st = await getSteamTileStatus();
          setTileAvailable(!!st?.available);
          // Already there (re-running the wizard) → leave it on; the write is
          // idempotent and unticking would be read as "remove it".
          if (st?.installed) setWantTile(true);
        } catch { /* ignore */ }
      }
    })();
  }, []);

  // Folder fields the user has edited by hand — never overwritten by the
  // re-seed below, which only fills in values they haven't expressed an opinion
  // about.
  const touchedDirs = useRef<Set<string>>(new Set());
  const markDir = (key: string, set: (v: string) => void) => (v: string) => {
    touchedDirs.current.add(key); set(v);
  };
  // An emulator appearing mid-wizard re-seeds the folder fields. The wizard read
  // get_config() on mount, when there was no emulator: ROMs/saves came back as
  // Ludo's own library fallbacks and BIOS came back empty. The backend has since
  // repaired those settings (repair_emulator_paths + align_saves_with_emulator,
  // run by install_emulator before it clears `active`), so without this the
  // stale mount-time values would be written straight back over the repair by
  // doFinish's saveConfig.
  const reseeded = useRef(false);
  useEffect(() => {
    if (hasEmuStep !== true || !emu?.installed || reseeded.current) return;
    reseeded.current = true;
    (async () => {
      try {
        const c = await getConfig();
        if (!touchedDirs.current.has('roms') && c.rom_directory) setRomDir(c.rom_directory);
        if (!touchedDirs.current.has('saves') && c.save_directory) setSaveDir(c.save_directory);
        if (!touchedDirs.current.has('bios') && c.bios_directory) setBiosDir(c.bios_directory);
      } catch { /* keep what we have; the folders step is still editable */ }
    })();
  }, [hasEmuStep, emu?.installed]);

  const finish = () => {
    // The wizard must not survive under the library in history — B at the
    // library root would walk straight back into completed setup.
    //
    // On desktop the wizard IS the history floor (boot replace-navs "/" → setup,
    // depth 1), and the shim's NavigateBack is a deliberate no-op there — so the
    // pop below did nothing and the library was pushed on top of the wizard.
    // Replacing the entry is what actually retires it, and it leaves the library
    // as the floor, where root-B is correctly inert.
    if (host.capabilities.exit) {
      try {
        // Cast: NavigateReplace belongs to a shell that owns its own history,
        // not to Steam's Navigation type — which is why it is behind a
        // capability rather than called unconditionally.
        (Navigation as any).NavigateReplace("/romm-sync-library");
        Navigation.CloseSideMenus();
        return;
      } catch { /* fall through to the pop-and-push below */ }
    }
    // Deck: Steam owns the stack and the wizard was pushed onto it, so popping
    // first is right — there is a real page underneath to pop to.
    try { Navigation.NavigateBack(); } catch { /* ignore */ }
    setTimeout(() => { Navigation.Navigate("/romm-sync-library"); Navigation.CloseSideMenus(); }, 60);
  };

  const doTest = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await testRommConnection(url.trim(), username.trim(), password)); }
    catch { setTestResult({ success: false, message: 'Test failed unexpectedly.' }); }
    finally { setTesting(false); }
  };

  // Connect step's primary action in pair mode: redeem the code, then advance.
  // A code that paired but failed to connect still counts as paired — it is
  // single-use and already spent, so retrying it can only report "expired".
  const doPair = async () => {
    setPairing(true); setTestResult(null);
    try {
      const r = await pairDevice(url.trim(), pairCode.trim());
      if (r?.paired) {
        setPaired(true);
        if (r?.connecting) {
          // The connect now runs on the sync thread, so it is still going when
          // we get here — on a large library, for minutes. Say so rather than
          // letting the next steps imply the library is already there.
          setTestResult({ success: true, message: 'Paired — loading your library in the background.' });
        } else if (!r?.success) {
          setTestResult({ success: true, message: 'Paired — the server isn\'t answering yet, but that can settle on its own.' });
        }
        next();
      } else {
        setTestResult({ success: false, message: r?.message || 'Pairing failed.' });
      }
    } catch {
      setTestResult({ success: false, message: 'Pairing failed.' });
    } finally { setPairing(false); }
  };

  // QR pairing is armed by a button rather than started as soon as the mode is
  // picked: device/init is rate-limited per-IP, and the URL field is still being
  // typed when the step opens — auto-starting would fire a request per keystroke
  // and burn the limit before the user finished the hostname.
  const [qrArmed, setQrArmed] = useState(false);
  useEffect(() => { setQrArmed(false); }, [url, mode]);
  const { qr, retry: qrRetry } = useQrPairing(
    url, cur === 'connect' && mode === 'qr' && qrArmed && !paired,
    (r) => {
      setPaired(true);
      setTestResult({
        success: true,
        message: r?.connecting
          ? 'Paired — loading your library in the background.'
          : 'Paired.',
      });
    },
  );

  const doFinish = async () => {
    setBusy(true);
    try {
      // The "Ludo" Steam library tile is mandatory — ensure it exists before
      // navigating away (create if missing; reconcile repairs an existing one).
      try {
        // force=true: this is user-initiated (store is long since loaded),
        // and a fresh install can legitimately have an empty shortcut list.
        if ((await host.launcher.reconcileTile()) == null) await host.launcher.ensureTile(true);
      } catch (e) { console.error('[RomM] wizard steam tile', e); }

      // Desktop: no SteamClient, so the tile is the opt-in shortcuts.vdf one
      // from the final step. Never fatal — a failed write must not block setup.
      if (host.capabilities.shortcutTile && tileAvailable && wantTile) {
        try {
          const spec = host.app.launchSpec();
          if (spec?.exe) {
            // No toast on success: the row the user just ticked says Steam has
            // to be restarted, so repeating it is noise on a screen they are
            // already leaving.
            await setSteamTile(true, spec.exe, spec.startDir || '', spec.args || '');
          }
        } catch (e) { console.error('[RomM] wizard desktop tile', e); }
      }

      if (mode !== 'login') {
        // Belt and braces: the Connect step does not advance unless pairing
        // succeeded, so this only fires if that invariant ever breaks. QR has
        // no code to redeem here — its token only ever arrives by approval —
        // so an unpaired QR run can only bail out.
        if (!paired) {
          const r = mode === 'qr'
            ? { paired: false, message: 'Scan the QR code to finish pairing.' }
            : await pairDevice(url.trim(), pairCode.trim());
          if (!r?.paired) {
            toaster.toast({ title: 'Ludo', body: r?.message || 'Pairing failed.' });
            return;
          }
        }
        // Already paired on the Connect step — all that is left is the folders
        // and the device name, which pair_device does not write. (Before pairing
        // moved earlier, these were silently discarded in pair mode: doFinish
        // called pair_device and nothing else.) Neither is worth blocking the
        // library on, so a failure is reported and setup still completes.
        try {
          await setLibraryPaths(romDir.trim(), saveDir.trim(), biosDir.trim(), undefined);
          await setDeviceNameRpc(deviceName.trim() || deviceNameDefault);
        } catch (e) {
          console.error('[RomM] wizard paired-finish', e);
          toaster.toast({ title: 'Ludo', body: 'Saved, but your folders may need checking in Settings.' });
        }
        // Only now — after the folders are written and the platform switches
        // are in — is it safe to let the library walk go. It reads the ROM
        // directory for every entry it builds, so starting it before
        // setLibraryPaths would mark a whole library as not-downloaded.
        try { await finishOnboarding(); } catch (e) { console.error('[RomM] wizard finish onboarding', e); }
        finish();
      } else {
        const dev = deviceName.trim() || deviceNameDefault;
        const r = await saveConfig(url.trim(), username.trim(), password, romDir.trim(), saveDir.trim(), dev, biosDir.trim());
        if (r?.success) { toaster.toast({ title: 'Ludo', body: 'Connected!' }); finish(); }
        else toaster.toast({ title: 'Ludo', body: r?.error || 'Failed to save configuration.' });
      }
    } catch { toaster.toast({ title: 'Ludo', body: 'Something went wrong.' }); }
    finally { setBusy(false); }
  };

  const next = () => setStep((s) => Math.min(s + 1, TOTAL - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  // QR is the one route with nothing left to do once it succeeds: there is no
  // field to finish and no button the user could press that means anything
  // other than "next". So take that press for them, after a beat long enough
  // to read the green line that says it worked.
  useEffect(() => {
    if (!(cur === 'connect' && mode === 'qr' && paired)) return;
    const t = setTimeout(() => next(), 1200);
    return () => clearTimeout(t);
  }, [cur, mode, paired]);
  // QR has no field to fill in beyond the URL, so the gate is the approval
  // itself — the step won't advance until the phone comes back.
  const canConnect = mode === 'qr'
    ? (url.trim() && paired)
    : mode === 'pair'
      ? (url.trim() && pairCode.trim())
      : (url.trim() && username.trim() && (password.length > 0 || hasPassword));

  const onField = (set: (v: string) => void, isPair = false) => (v: string) => { set(v); if (!isPair) setTestResult(null); };
  // Pair codes follow XXXX-XXXX — strip junk, uppercase, auto-insert the dash.
  const formatPairCode = (raw: string) => {
    const clean = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  };
  const browse = (cur: string, set: (v: string) => void) => async () => {
    try { const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(cur), false, true); if (res?.realpath) set(res.realpath); }
    catch { /* ignore */ }
  };

  // Footer: Back pinned left, Next/primary pinned right (space-between).
  // Dpad-down from the step content enters the footer at its FIRST child (Back),
  // but the primary action is what the user is walking toward — so when focus
  // arrives on Back from OUTSIDE the footer, bounce it to the primary. Moving
  // left from the primary (a deliberate trip to Back) is within-footer and
  // stays put: both buttons stamp footerTouch on focus/blur, and the redirect
  // only fires when the footer hasn't been touched in the last 250ms.
  const footerTouch = useRef(0);
  const footerPrimaryRef = useRef<any>(null);
  const footer = (primary: any) => {
    const pRef = primary?.props?.focusRef ?? footerPrimaryRef;
    const touch = () => { footerTouch.current = Date.now(); };
    const p = cloneElement(primary, { focusRef: pRef, onFocused: touch, onBlurred: touch });
    return (
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginTop: '8px' }}>
        <GameActionButton variant="surface" label="Back" icon={<FaChevronLeft size={13} />} onClick={back}
          onBlurred={touch}
          onFocused={() => {
            const fromOutside = Date.now() - footerTouch.current > 250;
            touch();
            // Deferred, twice: bouncing synchronously from inside Steam's focus
            // pass let it finish bookkeeping on Back afterward — the ring drew
            // on the primary but A still activated Back.
            if (fromOutside) [30, 150].forEach((d) => setTimeout(() => {
              try { if (pRef.current) _forceGamepadFocus(pRef.current); } catch { /* ignore */ }
            }, d));
          }} />
        {p}
      </Focusable>
    );
  };

  return (
    <div className="romm-ui" ref={scrollHostRef} style={{
      position: 'fixed', inset: 0, color: V2.fg, fontFamily: V2.font,
      // Not justify:center — that clips the top of tall content in a scroll
      // container. The card centers itself with margin:auto instead (below).
      // Bottom padding is only inflated while a field is focused (kbRoom), giving
      // scrollIntoView room to lift the field clear of the keyboard overlay
      // without shifting the resting (unfocused) layout upward.
      // 28px, not 40: the Folders step is the tallest and at 40px it overflowed
      // the Deck's ~533px CSS viewport — margin:auto centering collapsed (no top
      // space) and the footer clipped off-screen.
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: kbRoom ? '28px 24px 52vh' : '28px 24px', overflowY: 'auto',
    }}>
      <V2Bg uri={null} />
      {/* romm-ui + this rule strip the CEF :focus outline that otherwise leaves a
          stray white ring on a wizard field after the highlight moves on — the
          same treatment every in-library page gets via v2Page. */}
      <style>{V2_FOCUS_STYLE}</style>
      <style>{`
        @keyframes wizIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
        @keyframes wizPop { 0% { opacity: 0; transform: scale(0.6); } 60% { transform: scale(1.08); } 100% { opacity: 1; transform: scale(1); } }
        @keyframes wizDot { from { transform: scale(0.6); } to { transform: scale(1); } }
        .wiz-step > div > * { animation: wizIn 0.5s cubic-bezier(.22,1,.36,1) both; }
        .wiz-step > div > *:nth-child(1) { animation-delay: 0.02s; }
        .wiz-step > div > *:nth-child(2) { animation-delay: 0.07s; }
        .wiz-step > div > *:nth-child(3) { animation-delay: 0.12s; }
        .wiz-step > div > *:nth-child(4) { animation-delay: 0.17s; }
        .wiz-step > div > *:nth-child(5) { animation-delay: 0.22s; }
        .wiz-step > div > *:nth-child(6) { animation-delay: 0.27s; }
        .wiz-step > div > *:nth-child(n+7) { animation-delay: 0.32s; }
        .wiz-logo { animation: wizPop 0.55s cubic-bezier(.22,1,.36,1) both !important; filter: drop-shadow(0 6px 24px rgba(139,116,232,0.45)); }
        .wiz-check { animation: wizPop 0.6s cubic-bezier(.34,1.56,.64,1) both !important; }
        .wiz-dot { transition: width 0.32s cubic-bezier(.22,1,.36,1), background 0.32s ease; }
        .wiz-dot--active { animation: wizDot 0.32s ease; }
      `}</style>
      <Focusable noFocusRing
        // L1/R1 flip the login ↔ pair mode on the Connect step (mirrors the
        // home page's bumper tab paging; the keycaps flank the segment pill).
        onButtonDown={(evt: any) => {
          if (cur !== 'connect') return;
          const b = evt?.detail?.button;
          if (b === GamepadButton.BUMPER_LEFT || b === GamepadButton.BUMPER_RIGHT) {
            playSteamSound('deck_ui_tab_transition_01');
            const dir = b === GamepadButton.BUMPER_LEFT ? -1 : 1;
            setMode((m) => WIZ_MODES[
              (WIZ_MODES.indexOf(m) + dir + WIZ_MODES.length) % WIZ_MODES.length]);
            setTestResult(null);
          }
        }}
        style={{
          position: 'relative', zIndex: 2, width: '100%', maxWidth: '440px', margin: 'auto 0',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center',
        }}>
        {/* Progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
          {Array.from({ length: TOTAL }).map((_, i) => (
            <div key={i} className={`wiz-dot${i === step ? ' wiz-dot--active' : ''}`} style={{
              width: i === step ? '22px' : '8px', height: '8px', borderRadius: V2.radiusPill,
              background: i <= step ? V2.brand : V2.surfaceHover,
            }} />
          ))}
        </div>

        <div key={step} className="wiz-step" style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '22px' }}>
          {cur === 'welcome' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center' }}>
              {logo && <img className="wiz-logo" src={logo} style={{ width: '96px', height: '96px', objectFit: 'contain' }} />}
              <div style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.01em' }}>Welcome to Ludo</div>
              <div style={{ fontSize: '14px', color: V2.fg2, lineHeight: 1.6, maxWidth: '420px' }}>
                Connect to your RomM server to browse, download, and sync saves.
              </div>
              <div style={{ marginTop: '8px' }}>
                <GameActionButton variant="emphasized" label="Get started" focusRef={startFocusRef} icon={<FaPlay size={13} style={{ marginLeft: '2px' }} />} onClick={next} />
              </div>
            </div>
          )}

          {cur === 'connect' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', width: '100%' }}>
              <div style={{ fontSize: '20px', fontWeight: 700 }}>Connect to RomM</div>
              {/* QR / Pair / Login toggle — same segmented pill as the update
                  channel, flanked by L1/R1 keycaps like the home nav: bumpers
                  cycle the mode. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                <Bumper label="L1" />
                <V2Segment
                  options={[{ id: 'qr', label: 'Scan QR' }, { id: 'pair', label: 'Pair code' }, { id: 'login', label: 'Username & password' }]}
                  value={mode}
                  onChange={(m) => { setMode(m as WizMode); setTestResult(null); }}
                />
                <Bumper label="R1" />
              </div>
              {/* Hidden while a QR code is live. Editing the URL resets qrArmed
                  and throws that code away, so the field is not merely useless
                  there — it is a focus stop whose only effect is to destroy what
                  the user is currently scanning. It comes back for `idle` and
                  `error`, which is exactly when the URL is worth touching: a
                  wrong host fails into the error branch, and "Try again" is only
                  worth pressing next to a URL you can fix first. */}
              {!(mode === 'qr' && qrArmed && qr.status !== 'error') && (
                <V2TextField label="RomM URL" value={url} onChange={onField(setUrl)} placeholder="https://romm.example.com" onKb={setKbRoom} focusRef={urlFocusRef} />
              )}
              {mode === 'login' ? (
                <>
                  <V2TextField label="Username" value={username} onChange={onField(setUsername)} onKb={setKbRoom} />
                  <V2TextField label="Password" value={password} onChange={onField(setPassword)} password
                    placeholder={hasPassword && !password ? 'Leave blank to keep saved' : undefined} onKb={setKbRoom}
                    onEnter={() => { if (canConnect) next(); }} />
                  {testResult && (
                    <div style={{ fontSize: '13px', color: testResult.success ? V2.success : V2.danger }}>
                      {testResult.success ? <FaCheck size={11} style={{ verticalAlign: '-1px' }} /> : <FaTimes size={11} style={{ verticalAlign: '-1px' }} />} {testResult.message}
                    </div>
                  )}
                  <GameActionButton variant="surface" label={testing ? 'Testing…' : 'Test connection'} icon={null}
                    disabled={testing || !url.trim() || !username.trim()} onClick={doTest} />
                </>
              ) : mode === 'qr' ? (
                <>
                  {!qrArmed ? (
                    <GameActionButton variant="surface" label="Show QR code" icon={null}
                      disabled={!url.trim()} onClick={() => setQrArmed(true)} />
                  ) : qr.status === 'starting' ? (
                    <div style={{ fontSize: '13px', color: V2.fg2 }}>Getting a code…</div>
                  ) : qr.status === 'error' ? (
                    <>
                      <div style={{ fontSize: '13px', color: V2.danger, maxWidth: '380px', lineHeight: 1.5 }}>
                        ❌ {qr.message}
                      </div>
                      {/* An old server is a dead end for QR but not for pairing —
                          point at the route that still works rather than leaving
                          a retry button that will fail the same way. */}
                      {qr.unavailable
                        ? <GameActionButton variant="surface" label="Use a pair code instead" icon={null}
                          onClick={() => { setMode('pair'); setTestResult(null); }} />
                        : <GameActionButton variant="surface" label="Try again" icon={null} onClick={qrRetry} />}
                    </>
                  ) : (
                    // Laid out as a row, not a column: the Deck's ~533px viewport
                    // has to hold the whole step INCLUDING the Back/Next footer,
                    // and stacking the code, the instruction and the spinner
                    // under the QR pushed that footer below the fold — the user
                    // had to scroll to find the buttons. Beside the QR they cost
                    // no height at all, because the QR is the tallest thing here
                    // either way.
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      gap: '16px', width: '100%', textAlign: 'left',
                    }}>
                      {qr.matrix
                        ? <div style={{
                            opacity: qr.status === 'approved' ? 0.35 : 1,
                            transition: 'opacity 0.3s ease', lineHeight: 0,
                          }}><QrCode matrix={qr.matrix} size={148} /></div>
                        : (
                          // No QR encoder bundled — the flow still works, the
                          // user just opens the URL by hand.
                          <div style={{ fontSize: '13px', color: V2.fg2, maxWidth: '380px', wordBreak: 'break-all' }}>
                            {qr.verifyUrl}
                          </div>
                        )}
                      {/* Everything that changes between waiting and approved
                          changes INSIDE this column, and the column is never
                          taller than the QR beside it. So the step's height is
                          the QR's height, start to finish: nothing reflows under
                          the user, and the footer never moves. That is also why
                          the QR stays mounted after approval — greyed, but
                          holding its space. */}
                      <div style={{
                        display: 'flex', flexDirection: 'column', justifyContent: 'center',
                        gap: '10px', minWidth: 0, flex: '1 1 auto',
                      }}>
                      {qr.status === 'approved' ? (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div className="wiz-check" style={{
                              width: '30px', height: '30px', flex: 'none', borderRadius: '50%',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: V2.success, color: '#0b1410',
                              boxShadow: '0 4px 18px rgba(74,222,128,0.35)',
                            }}>
                              <FaCheck size={15} />
                            </div>
                            <div style={{ fontSize: '17px', fontWeight: 700, color: V2.fg }}>Paired</div>
                          </div>
                          <div style={{ fontSize: '12px', color: V2.fg2, lineHeight: 1.5 }}>
                            {testResult?.message && testResult.message !== 'Paired.'
                              ? testResult.message
                              : 'Signed in to your RomM server.'}
                          </div>
                        </>
                      ) : (
                        <>
                      {/* Only while there is still something to do. */}
                      <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.5 }}>
                        Scan with your phone, then approve on your RomM server.
                      </div>
                      {/* The code is shown alongside the QR, not instead of it:
                          anyone already signed in on another device can go to
                          /pair/device and type these eight characters. */}
                      {qr.userCode && (
                        <div style={{ fontFamily: 'monospace', fontSize: '18px', fontWeight: 700, letterSpacing: '0.18em', color: V2.fg }}>
                          {qr.userCode}
                        </div>
                      )}
                      {qr.status === 'waiting' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: V2.fgMuted }}>
                          <FaSync size={11} style={{ animation: 'spin 1s linear infinite' }} />
                          Waiting for approval…
                        </div>
                      )}
                        </>
                      )}
                      </div>
                    </div>
                  )}
                  {/* Success is reported inside the panel above now, in the space
                      the instructions were using. Repeating it here would append
                      a line — the exact reflow that was shoving the footer down. */}
                  {testResult && !(qr.status === 'approved' && testResult.success) && (
                    <div style={{ fontSize: '13px', color: testResult.success ? V2.success : V2.danger }}>
                      {testResult.success ? <FaCheck size={11} style={{ verticalAlign: '-1px' }} /> : <FaTimes size={11} style={{ verticalAlign: '-1px' }} />} {testResult.message}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <PairCodeField label="Pairing code" value={pairCode}
                    onChange={(v) => { setPairCode(formatPairCode(v)); setTestResult(null); }} onKb={setKbRoom}
                    onEnter={() => { if (canConnect && !paired) doPair(); }} />
                  {testResult && (
                    <div style={{ fontSize: '13px', color: testResult.success ? V2.success : V2.danger }}>
                      {testResult.success ? <FaCheck size={11} style={{ verticalAlign: '-1px' }} /> : <FaTimes size={11} style={{ verticalAlign: '-1px' }} />} {testResult.message}
                    </div>
                  )}
                </>
              )}
              {footer(
                mode === 'pair' && !paired
                  ? <GameActionButton variant="emphasized" disabled={!canConnect || pairing}
                    label={pairing ? 'Pairing…' : 'Pair & continue'}
                    icon={pairing ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FaChevronRight size={13} />}
                    onClick={doPair} />
                  : <GameActionButton variant="emphasized" label="Next" icon={<FaChevronRight size={13} />} disabled={!canConnect} onClick={next} />
              )}
            </div>
          )}

          {cur === 'emulator' && (() => {
            const done = !!emu?.installed;
            const active = emuInstall.active;
            const canInstall = !!emu?.install?.available;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', width: '100%', textAlign: 'center' }}>
                <div style={{ color: done ? V2.success : V2.brandHover }}>
                  {done ? <FaCheckCircle size={44} /> : <FaGamepad size={44} />}
                </div>
                <div style={{ fontSize: '20px', fontWeight: 700 }}>
                  {done ? 'Emulator ready' : active ? 'Installing RetroArch' : 'No emulator installed'}
                </div>
                <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.6, maxWidth: '420px' }}>
                  {done
                    ? 'RetroArch is installed. The next step is set up to use its folders.'
                    : active
                      // Leaving mid-install is safe: it runs in a backend thread,
                      // and the folder fields re-seed when it lands.
                      ? 'This takes a few minutes. You can carry on with setup while it runs.'
                      : canInstall
                        ? 'Ludo can download and sync your library without one, but playing needs RetroArch or RetroDECK.'
                        // No button we could offer would work here (Windows, no
                        // flatpak, running as root) — say why instead.
                        : `Ludo can download and sync your library without one, but playing needs RetroArch or RetroDECK — ${emu?.install?.reason || 'install one to play'}.`}
                </div>
                {active && (
                  <div style={{ width: '100%' }}>
                    <InstallProgressBar pct={emuInstall.pct} />
                    <div style={{ fontSize: '12px', color: V2.fgMuted, marginTop: '6px' }}>
                      {[emuInstall.phase, installSize(emuInstall), emuInstall.detail].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                )}
                {emuInstall.error && !active && (
                  <div style={{ fontSize: '13px', color: V2.danger }}>❌ {emuInstall.error}</div>
                )}
                {!done && !active && canInstall && (
                  <GameActionButton variant="emphasized" label={emuInstall.error ? 'Try again' : 'Install RetroArch'}
                    icon={<FaDownload size={14} />} onClick={startEmulatorInstall} />
                )}
                {footer(
                  <GameActionButton variant={done ? 'emphasized' : 'surface'} focusRef={emuNextRef}
                    // Skipping is a first-class choice: collecting ROMs before
                    // owning an emulator is legitimate, and the Home banner keeps
                    // offering the install afterwards.
                    label={done || active ? 'Next' : 'Skip for now'}
                    icon={<FaChevronRight size={13} />} onClick={next} />
                )}
              </div>
            );
          })()}

          {cur === 'folders' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '100%' }}>
              <div style={{ fontSize: '20px', fontWeight: 700 }}>Folders</div>
              <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.5, maxWidth: '420px' }}>
                Where ROMs, saves and BIOS files live on this device.
                {/* Without an emulator these are Ludo's own folders, not one an
                    emulator reads — worth saying, since the saves one is the
                    path that silently breaks sync later. */}
                {hasEmuStep && !emu?.installed && !emuInstall.active
                  && ' With no emulator installed these are Ludo\'s own folders — installing one later will point saves and BIOS at it.'}
              </div>
              {/* Field + Browse share a row: the stacked layout was taller than
                  the viewport, which clipped the footer buttons and killed the
                  centered spacing. flex-end aligns the button with the input box
                  (the field's label sits above it). */}
              {([
                ['ROM directory', 'roms', romDir, setRomDir],
                ['Save directory', 'saves', saveDir, setSaveDir],
                ['BIOS directory', 'bios', biosDir, setBiosDir],
              ] as [string, string, string, (v: string) => void][]).map(([lbl, key, val, raw]) => {
                const set = markDir(key, raw);
                return (
                <Focusable key={lbl} noFocusRing flow-children="horizontal"
                  style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', width: '100%' }}>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <V2TextField label={lbl} value={val} onChange={set} onKb={setKbRoom} />
                  </div>
                  <GameActionButton variant="surface" label="Browse…" icon={null} onClick={browse(val, set)} />
                </Focusable>
                );
              })}
              <V2TextField label="Device name" value={deviceName} onChange={setDeviceName} placeholder={deviceNameDefault} onKb={setKbRoom} />
              {footer(
                <GameActionButton variant="emphasized" label="Next" focusRef={foldersNextRef} icon={<FaChevronRight size={13} />} onClick={next} />
              )}
            </div>
          )}

          {/* Optional, and pre-filled with everything ON: the step's only job is
              subtraction, so skipping it and completing it produce the same
              working setup. Nothing here can leave the user worse off. */}
          {cur === 'platforms' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '100%' }}>
              <div style={{ fontSize: '20px', fontWeight: 700 }}>Platforms</div>
              <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.5, maxWidth: '440px', textAlign: 'center' }}>
                Turn off what you don’t need.
              </div>
              {/* The running total, not the server's total: this is the number
                  the switches move, and it is the whole reason to touch them.
                  Held at a fixed height so flipping a switch doesn't reflow the
                  list under the user's thumb. */}
              <div style={{ fontSize: '13px', fontWeight: 600, color: V2.fg, height: '18px' }}>
                {platformSync.loading
                  ? ' '
                  : `${platformSync.enabledCount} of ${platformSync.rows.length} platforms · ${platformSync.enabledRoms.toLocaleString()} of ${platformSync.totalRoms.toLocaleString()} games`}
              </div>
              {/* Scrolls inside its own box rather than growing the card. The
                  card centers itself with margin:auto, which silently collapses
                  once the content outgrows the viewport — so an unbounded list
                  (30+ platforms on a real server) is what pinned this one step
                  to the top while every other step sat centered. */}
              <ScrollFade maxHeight="42vh"
                refresh={`${platformSync.rows.length}:${platformSync.off.size}`}
                style={{
                  width: '100%', display: 'flex', flexDirection: 'column', gap: '8px',
                  // Room for the focus ring on the first/last row, which a flush
                  // scroll edge would clip.
                  padding: '2px',
                }}>
                <PlatformSyncList sync={platformSync} />
              </ScrollFade>
              {footer(
                <GameActionButton variant="emphasized" focusRef={platformsNextRef}
                  label={platformSync.off.size ? 'Next' : 'Sync everything'}
                  icon={<FaChevronRight size={13} />} onClick={next} />
              )}
            </div>
          )}

          {cur === 'ready' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center', width: '100%' }}>
              <div className="wiz-check"><FaCheckCircle size={56} color={V2.success} /></div>
              <div style={{ fontSize: '24px', fontWeight: 800 }}>Ready to go</div>
              <div style={{ fontSize: '14px', color: V2.fg2, lineHeight: 1.6, maxWidth: '420px' }}>
                {mode !== 'login'
                  ? paired
                    ? 'This device is paired with your RomM server. We\'ll save your folders and open your library.'
                    : 'We\'ll pair this device with your RomM server and open your library.'
                  : 'We\'ll save your connection and open your library.'}
                {/* Finishing mid-install is fine — the backend thread carries on
                    and repoints the folders when it lands — but the user should
                    know why Play is still unavailable when they arrive. */}
                {emuInstall.active && ' RetroArch is still installing; it will be ready shortly.'}
              </div>
              {host.capabilities.shortcutTile && tileAvailable && (
                <div style={{ width: '100%', textAlign: 'left' }}>
                  <V2SettingsRow
                    icon={<FaExternalLinkAlt size={16} />}
                    title="Add to Steam library"
                    subtitle='Adds a "Ludo" tile. Restart Steam to see it.'
                    onClick={() => setWantTile((v) => !v)}
                    right={<V2Switch checked={wantTile} />}
                  />
                </div>
              )}
              {footer(
                <GameActionButton variant="emphasized" disabled={busy} focusRef={finishFocusRef}
                  label={busy ? 'Connecting…' : 'Finish & open library'}
                  icon={busy ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FaPlay size={13} style={{ marginLeft: '2px' }} />}
                  onClick={doFinish} />
              )}
            </div>
          )}
        </div>
      </Focusable>
    </div>
  );
}
