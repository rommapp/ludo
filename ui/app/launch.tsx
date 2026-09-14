import { host, showModal, toaster, Focusable, GamepadButton, ModalRoot} from "@ludo/host";
import { libNavigate } from "./nav";
import { libCacheSetDownloaded } from "./libcache";
import { launchGame, prepareSteamLaunch, downloadCore, getSyncEpoch, setCoreOverride} from "./rpc";
import { useRef, useState } from "react";
import { V2_FOCUS_STYLE } from "./focus";
import { V2 } from "./theme";
import { FaChevronRight, FaCog, FaPlay, FaPuzzlePiece, FaDownload, FaSync, FaTimes} from "react-icons/fa";
import { UserMenuRow, MODAL_SCRIM_INSET} from "./kit";
import { _broadcastLibRefresh } from "./events";
import { EmuStatus, loadEmulatorStatus, standaloneFor } from "./emulator";
import { invalidateStateThumbs } from "./tiles";
// Starting a game, and the one thing that differs between the two shells.
//
// On the Deck the emulator must run as a child of a Steam-tracked game or the
// overlay, screenshots and playtime tracking all go missing — so the backend
// resolves an argv into a launch spec and the Steam tile is run against it. On
// a PC there is no such session host, so the same call just runs the emulator.
// host.launcher is the seam; this is the only place that cares.

// ── Missing-core picker ──────────────────────────────────────────────────────
// A launch that fails for a missing core is fixable right there, so instead of a
// toast that only names the problem, offer the fix: install the recommended core
// for that platform (or a different one), then start the game. Same glass chrome
// as the user menu.
let _rommLastLaunchedRomId: number | null = null;

/** The rom the last launch was for, for the post-session focus restore. */
export function lastLaunchedRomId(): number | null { return _rommLastLaunchedRomId; }

// The name RetroArch itself shows for a core, when the backend could read it
// out of the core's .info. Worth the lookup because the two names can share no
// characters at all: 'pcsx2' is "LRPS2" in every RetroArch menu, so offering
// the filename sends someone hunting for a core that is not in the list under
// that name. The raw identifier still shows underneath either way.
function coreLabel(name: string, labels?: Record<string, string>): string {
  const known = labels?.[name];
  if (known) return known;
  // No .info to read (an uninstalled core with no cached bundle): buildbot
  // names like 'mupen64plus_next' are readable enough with spaces.
  return name.replace(/_libretro$/, '').replace(/_/g, ' ');
}

type CoreGap = {
  platform_name: string;
  platform_slug: string;
  candidates: string[];
  core_labels?: Record<string, string>;
  installed_cores: string[];
  can_download: boolean;
  download_reason: string;
};

// Alternatives shown without asking. Two rows cost less attention than a row
// that says "two more rows in here".
const INLINE_CORES = 2;

// Rows for the branches that have no core to offer. "Manage cores" is the only
// way forward from here; "Close" exists so the panel always owns focus.
function CoreDeadEndActions({ closeModal }: { closeModal?: () => void }) {
  return (
    <>
      <div style={{ height: '1px', background: V2.border, margin: '4px' }} />
      <UserMenuRow icon={<FaCog size={14} />} label="Manage cores"
        onSelect={() => { closeModal?.(); libNavigate('/romm-sync-cores'); }} />
      <UserMenuRow icon={<FaTimes size={14} />} label="Close"
        onSelect={() => closeModal?.()} />
    </>
  );
}

// One installable core in the picker: name, what it is, and its state.
function CoreOption({ core, label, recommended, busy, disabled, onSelect }:
  { core: string; label?: string; recommended?: boolean; busy?: boolean; disabled?: boolean; onSelect: () => void }) {
  const [hot, setHot] = useState(false);
  return (
    <Focusable noFocusRing onActivate={() => !disabled && onSelect()} onClick={() => !disabled && onSelect()}
      onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 12px',
        borderRadius: V2.radiusMd, cursor: disabled ? 'default' : 'pointer',
        background: (hot && !disabled) ? V2.surfaceHover : 'transparent',
        transition: 'background 0.12s ease', opacity: disabled && !busy ? 0.55 : 1,
      }}>
      <div style={{ flexShrink: 0, width: '16px', display: 'flex', justifyContent: 'center', color: V2.fgMuted }}>
        {busy
          ? <FaSync size={13} style={{ animation: 'spin 1s linear infinite' }} />
          : <FaDownload size={13} />}
      </div>
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{
          fontSize: '13.5px', fontWeight: 500,
          // A real display name is already cased the way its authors wrote it
          // ("PCSX ReARMed"); only the derived-from-filename fallback wants
          // capitalising.
          textTransform: label ? 'none' : 'capitalize',
        }}>
          {label || coreLabel(core)}
          {recommended && (
            <span style={{
              marginLeft: '7px', fontSize: '9.5px', fontWeight: 800, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: V2.brandHover,
            }}>recommended</span>
          )}
        </div>
        <div style={{ fontSize: '10.5px', color: V2.fgFaint, marginTop: '1px' }}>
          {busy ? 'Installing…' : core}
        </div>
      </div>
    </Focusable>
  );
}

// Refresh what a play session changed, once it has actually ended.
//
// The emulator is a separate process that takes over the screen, so nothing in
// the UI observes the session: Continue playing (RomM's server-side
// last_played) and the resume screenshots both only change after the
// end-of-session save-sync uploads. Without this the row was a restart behind —
// the game just played wasn't in it, and its new state had no thumbnail.
//
// The backend's sync epoch advances when that sync completes, so poll it until
// it moves. Cheap (an int over the existing RPC channel) and self-limiting.
let _sessionWatch: any = null;

function MissingCoreModal({ gap, onPlay, closeModal }:
  { gap: CoreGap; onPlay: () => void; closeModal?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string>('');
  const [showAll, setShowAll] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const recommended = gap.candidates[0] || '';
  const others = gap.candidates.slice(1);

  const install = async (core: string) => {
    setBusy(core); setFailed('');
    try {
      const r = await downloadCore(core);
      if (!r?.success) {
        setFailed(r?.message || `Could not install ${core}`);
        return;
      }
      // Pin it for this platform when it isn't the one we'd have guessed:
      // otherwise resolution could pick a different installed core next time and
      // the user's choice here would look ignored.
      if (core !== recommended && gap.platform_slug) {
        try { await setCoreOverride(gap.platform_slug, core); } catch { /* non-fatal */ }
      }
      setDone(core);
      // The cores page and the emulator status both cache a core count.
      try { await loadEmulatorStatus(true); } catch { /* non-fatal */ }
    } catch (e) {
      setFailed(String(e));
    } finally {
      setBusy(null);
    }
  };

  const playNow = () => { closeModal?.(); onPlay(); };

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
          position: 'relative', width: '420px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '10px 10px 12px', minWidth: 0 }}>
            <div style={{
              flexShrink: 0, width: '34px', height: '34px', borderRadius: V2.radiusMd,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: V2.bgElevated, color: V2.brandHover,
            }}><FaPuzzlePiece size={16} /></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1.3 }}>
                {done ? 'Core installed' : `${gap.platform_name} needs a core`}
              </div>
              <div style={{ fontSize: '11.5px', color: V2.fgMuted, marginTop: '2px' }}>
                {done
                  ? `${coreLabel(done, gap.core_labels)} is ready — start the game.`
                  : 'A core is the emulator that actually runs the game.'}
              </div>
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />

          {failed && (
            <div style={{
              margin: '4px', padding: '9px 11px', borderRadius: V2.radiusMd,
              background: 'rgba(255,80,80,0.10)', color: V2.danger,
              fontSize: '11.5px', lineHeight: 1.4,
            }}>{failed}</div>
          )}

          {done ? (
            <UserMenuRow icon={<FaPlay size={14} />} label="Play now" onSelect={playNow} />
          ) : !gap.can_download ? (
            // Dead ends still need a focusable row: without one nothing inside
            // the panel takes gamepad focus, so B never reaches this modal and
            // navigates the page behind it instead.
            <>
              <div style={{ padding: '4px 12px 10px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
                {gap.download_reason
                  || 'Cores cannot be installed from here. Add one in RetroArch, then try again.'}
              </div>
              <CoreDeadEndActions closeModal={closeModal} />
            </>
          ) : !gap.candidates.length ? (
            <>
              <div style={{ padding: '4px 12px 10px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
                No core for {gap.platform_name} is available from the libretro
                buildbot for this system. You can install one inside RetroArch and
                pick it in Settings ▸ Emulator Cores.
              </div>
              <CoreDeadEndActions closeModal={closeModal} />
            </>
          ) : (
            <>
              <CoreOption core={recommended} label={gap.core_labels?.[recommended]} recommended busy={busy === recommended}
                disabled={!!busy} onSelect={() => install(recommended)} />
              {/* One or two alternatives are shorter than the row that would
                  hide them, so show them. Collapse only when the list is long
                  enough that it would bury the recommendation. */}
              {others.length > 0 && others.length <= INLINE_CORES && others.map((c) => (
                <CoreOption key={c} core={c} label={gap.core_labels?.[c]} busy={busy === c} disabled={!!busy}
                  onSelect={() => install(c)} />
              ))}
              {others.length > INLINE_CORES && !showAll && (
                <UserMenuRow icon={<FaChevronRight size={13} />}
                  label={`Other cores (${others.length})`} disabled={!!busy}
                  onSelect={() => setShowAll(true)} />
              )}
              {others.length > INLINE_CORES && showAll && others.map((c) => (
                <CoreOption key={c} core={c} label={gap.core_labels?.[c]} busy={busy === c} disabled={!!busy}
                  onSelect={() => install(c)} />
              ))}
              <div style={{ height: '1px', background: V2.border, margin: '4px' }} />
              <UserMenuRow icon={<FaCog size={14} />} label="Manage cores"
                disabled={!!busy}
                onSelect={() => { closeModal?.(); libNavigate('/romm-sync-cores'); }} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

function watchForSessionEnd() {
  if (_sessionWatch) return;   // one watcher is enough; launches are serial
  const POLL_MS = 5000;
  // ~4h. A session longer than this is possible, but a watcher that outlives
  // its usefulness should stop rather than poll for the rest of the session.
  const MAX_TICKS = 2880;
  let ticks = 0;
  let base: number | null = null;
  const stop = () => { clearInterval(_sessionWatch); _sessionWatch = null; };
  _sessionWatch = setInterval(async () => {
    if (++ticks > MAX_TICKS) { stop(); return; }
    try {
      const e = (await getSyncEpoch())?.epoch;
      if (typeof e !== 'number') return;
      if (base === null) { base = e; return; }
      if (e === base) return;
      stop();
      invalidateStateThumbs();
      _broadcastLibRefresh();
    } catch { /* transient — keep watching */ }
  }, POLL_MS);
}

export async function runLaunch(romId: number, gameName: string, disc: string | null,
  label?: string, setBusy?: (b: any) => void, onDone?: () => void, siblingRomId?: number | null) {
  if (setBusy) setBusy('launch');
  try {
    const r = await launchGameSmart(romId, disc, siblingRomId ?? null);
    if (r?.success && r?.bios_warning) {
      // The launch itself succeeded, so this is deliberately not an error: the
      // core starts and then sits on a black screen with nothing to explain it.
      // Fires whenever RomM holds firmware for the platform that isn't on disk —
      // not only when the resolved core marks it required, because the user can
      // pick a different core inside RetroArch and a pcsx_rearmed-shaped check
      // would go quiet exactly when the BIOS is needed. severity says which.
      const w = r.bios_warning;
      const miss: string[] = w.missing_bios || [];
      toaster.toast({
        title: `${w.platform_name || 'This platform'} BIOS missing`,
        body: `${w.severity === 'required'
          ? `${w.core} will not boot without ` : `${label || gameName} may need `}`
          + `${miss.slice(0, 3).join(', ')}${miss.length > 3 ? '…' : ''}. `
          + 'Open Firmware / BIOS to download them.',
        duration: 10000,
        // The index, not this platform's panel: the toast is clicked at some
        // remove from the launch, often with RetroArch already up, and a modal
        // over whatever is on screen by then is the wrong shape of interruption.
        onClick: () => libNavigate('/romm-sync-bios'),
      });
    }
    // The gap existed and the launch closed it by downloading. Said plainly
    // because the launch visibly took longer than usual and something was
    // written to disk — an unexplained pause reads as a stall, and "we fetched
    // your BIOS" is also the answer to why it works now when it didn't before.
    else if (r?.success && r?.bios_fetched?.length) {
      const got: string[] = r.bios_fetched;
      toaster.toast({
        title: `Launching ${label || gameName}`,
        body: `Downloaded ${got.length} missing BIOS file${got.length > 1 ? 's' : ''} first: `
          + `${got.slice(0, 3).join(', ')}${got.length > 3 ? '…' : ''}`,
      });
    }
    // No toast on a plain successful launch: the emulator takes over the
    // screen a moment later, so the notification announces something the user
    // is already watching happen. The BIOS branch above still fires, because
    // that one is not about the launch -- it explains a longer-than-usual wait
    // and files written to disk.
    else if (offerCoreInstall(r, () => void runLaunch(
      romId, gameName, disc, label, setBusy, onDone, siblingRomId))) {
      // The picker owns the outcome now — no toast.
    } else {
      toaster.toast({ title: 'Launch failed', body: r?.message || 'Error' });
      // Self-heal a stale "downloaded" tile: if launch failed because the files
      // aren't actually there (deleted off-device in a prior session, cache not
      // yet reconciled), flip every cached surface back to not-downloaded so the
      // cover offers Download instead of a Play that keeps failing.
      if (/not downloaded/i.test(r?.message || '')) libCacheSetDownloaded(romId, false);
    }
  } catch (e) {
    toaster.toast({ title: 'Launch failed', body: String(e) });
  } finally {
    if (setBusy) setBusy(null);
    if (onDone) onDone();
  }
}

// Launch a game. Under gamescope (Steam Deck Gaming Mode) this routes through
// the Ludo tile's session-host so the Steam overlay works: prepare_steam_launch
// writes the emulator argv, then we RunGame the tile and the host execs it as a
// Steam-tracked child. Anywhere that fails (not gamescope, no tile, RunGame
// unavailable) it falls back to the direct daemon launch.
export async function launchGameSmart(romId: number, disc: string | null = null,
  siblingRomId: number | null = null, resume: boolean = false): Promise<any> {
  // Armed here rather than per caller so every way into a game — tile, disc
  // picker, region picker, resume — gets its rows refreshed when it ends. A
  // launch that never starts is harmless: the watcher gives up on its own.
  watchForSessionEnd();
  // Every route into a game funnels through here (tile, disc picker, region
  // picker, resume), so this is the one place that always knows what was
  // launched — the post-session focus restore reads it.
  _rommLastLaunchedRomId = romId;
  try {
    if (await host.launcher.hasTile()) {
      const prep = await prepareSteamLaunch(romId, disc, siblingRomId, resume);
      if (prep?.steam_host) {
        if (await host.launcher.launchTile()) {
          // Carry the prep's BIOS verdict through: this path returns a synthetic
          // success, so anything prepare_steam_launch resolved (the warning, or
          // the files it fetched to avoid one) is lost unless it is forwarded.
          return { success: true, message: 'Launching',
            ...(prep.bios_warning ? { bios_warning: prep.bios_warning } : {}),
            ...(prep.bios_fetched ? { bios_fetched: prep.bios_fetched } : {}) };
        }
        // launchTile already reset its own session state; fall through to the
        // direct daemon launch below.
      } else if (prep && prep.success === false && prep.steam_host === false
        && prep.message && prep.message !== 'Not running under gamescope') {
        // A real failure (e.g. game not downloaded) — surface it rather than
        // silently falling back to a direct launch that would fail the same way.
        return prep;
      }
    }
  } catch (e) { console.error('[RomM] launchGameSmart', e); }
  return await launchGame(romId, disc, siblingRomId, resume);
}

// A launch that failed for a missing core: offer to install one and start the
// game, instead of a toast that only names the problem. Returns true when the
// picker took over, so the caller skips its own error toast.
export function offerCoreInstall(r: any, retry: () => void): boolean {
  if (!r?.needs_core) return false;
  showModal(
    <MissingCoreModal
      gap={{
        platform_name: r.platform_name || 'This platform',
        platform_slug: r.platform_slug || '',
        candidates: r.candidates || [],
        core_labels: r.core_labels || {},
        installed_cores: r.installed_cores || [],
        can_download: !!r.can_download,
        download_reason: r.download_reason || '',
      }}
      onPlay={retry} />
  );
  return true;
}

// True when this game can't be launched: no RetroArch, and no standalone
// emulator that covers its platform either.
export function cannotLaunch(status: EmuStatus | null,
                      platform?: string | null, slug?: string | null): boolean {
  if (status == null) return false;
  const alt = standaloneFor(status, platform, slug);
  if (alt) return !alt.installed;   // its platform never uses a core
  return !status.installed;
}
