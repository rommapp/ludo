import { emulatorInstallState, getEmulatorStatus, getPlatformSync, installEmulator, refreshFromRomm, setPlatformSync } from "./rpc";
import { useEffect, useRef, useState } from "react";
import { toaster } from "@ludo/host";
import { _broadcastLibRefresh } from "./events";
import { PlatformIcon, V2SettingsRow, V2Switch } from "./kit";
import { FaLayerGroup } from "react-icons/fa";
import { V2 } from "./theme";
// Is there an emulator, is it installing, and does it still point at the right
// folders.
//
// One module because those three questions share a state machine: an install
// that finishes has to republish the status, and a status that comes back with
// stale paths is what the wizard's repair step acts on. Both the wizard and the
// Cores page drive it, and neither owns it.

// True while the setup wizard is on screen. Its Emulator step reports the
// install's every state inline — progress, failure, and a "Emulator ready"
// panel — so the module-level toasts would just repeat it back over a screen
// that already says so.
let _wizardOpen = false;

/**
 * Set while the setup wizard is on screen. A function rather than the binding
 * itself because an imported `let` is read-only at the importing end.
 */
export function setWizardOpen(v: boolean) { _wizardOpen = v; }

export type EmuStatus = {
  installed: boolean;
  kind: 'retrodeck' | 'flatpak' | 'snap' | 'native' | 'none';
  executable: string | null;
  cores_dir: string | null;
  core_count: number;
  stale_paths: EmuStalePath[];
  // Emulators outside RetroArch that own a platform outright (Eden for Switch).
  // Independent of `installed` above: their games play with no RetroArch here.
  standalone: EmuStandalone[];
  save_dirs: Record<string, string>;
  bios_dir: string;
  // Raw configured values by kind — '' means "not set, we detect it".
  configured_paths: Record<string, string>;
  // What each folder would be with nothing chosen, so a row can offer to go
  // back to it. '' means "clear it and let detection answer".
  default_paths: Record<string, string>;
  // Where the detected emulator keeps things, existing yet or not — what a row
  // shows when nothing is configured and nothing is on disk to detect.
  expected_paths: Record<string, string>;
  // Whether Ludo can install an emulator itself. False on Windows, without
  // flatpak, or as root — the reason is what we show instead of the button.
  install: { available: boolean; reason: string };
};

export type EmuStandalone = {
  key: string; name: string; installed: boolean; executable: string;
  // Lowercase tokens matched against a game's platform name and slug.
  platforms: string[];
};

// ── Emulator status ─────────────────────────────────────────────────────────
// Whether RetroArch/RetroDECK is actually installed, and whether any saved
// folder still points into an emulator that was uninstalled. One fetch serves
// the whole UI (Home banner, Play button, Emulator page). The backend re-detects
// on every plugin start, so this cache only needs invalidating when WE change
// something — a path repair or an install — which is what refresh does.
export type EmuStalePath = {
  section: string; key: string; label: string; kind: string;
  value: string; reason: string; suggested: string;
  // Why it's wrong. 'removed': the install it belonged to is gone.
  // 'other_install': that install is alive, it just isn't the one we launch —
  // then `owner` and `active` name the two, which the copy needs to be
  // comprehensible ("going to RetroArch, but games run on RetroDECK").
  cause?: 'removed' | 'other_install'; owner?: string; active?: string;
};

export let _emuStatus: EmuStatus | null = null;

export const _emuSubs = new Set<() => void>();

export let _emuInflight: Promise<EmuStatus | null> | null = null;

export async function loadEmulatorStatus(refresh = false): Promise<EmuStatus | null> {
  // Coalesce: several components mount at once on a cold start and would
  // otherwise each pay for the (filesystem-probing) detection.
  if (!refresh && _emuInflight) return _emuInflight;
  const run = (async () => {
    try {
      const r = await getEmulatorStatus(refresh);
      if (r?.success) {
        publishEmulatorStatus({
          installed: !!r.installed,
          kind: r.kind || 'none',
          executable: r.executable || null,
          cores_dir: r.cores_dir || null,
          core_count: r.core_count || 0,
          stale_paths: r.stale_paths || [],
          standalone: r.standalone || [],
          save_dirs: r.save_dirs || {},
          bios_dir: r.bios_dir || '',
          configured_paths: r.configured_paths || {},
          default_paths: r.default_paths || {},
          expected_paths: r.expected_paths || {},
          install: r.emulator_install || { available: false, reason: '' },
        });
      }
    } catch { /* leave the last known answer in place */ }
    finally { _emuInflight = null; }
    return _emuStatus;
  })();
  _emuInflight = run;
  return run;
}

export function publishEmulatorStatus(s: EmuStatus | null) {
  _emuStatus = s;
  [..._emuSubs].forEach((f) => f());
}

export function useEmulatorStatus(): EmuStatus | null {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    _emuSubs.add(f);
    if (!_emuStatus) loadEmulatorStatus();
    return () => { _emuSubs.delete(f); };
  }, []);
  return _emuStatus;
}

// ── RetroArch install ───────────────────────────────────────────────────────
// The install runs in a backend thread (a few hundred MB of flatpak, plus the
// KDE runtime if it isn't already there); the UI polls its
// progress. Module-level so the Home banner and the Emulator page show the same
// run, and so navigating away mid-install doesn't orphan it.
export type EmuInstall = {
  active: boolean; phase: string; pct: number | null; detail: string; error: string | null;
  // Real byte counts from flatpak's own ref table, or null when it couldn't be
  // read — the size varies hugely with whether the KDE runtime tags along, so
  // there is no sane fallback number to invent.
  bytesDone: number | null; bytesTotal: number | null;
};

export const _emuInstallSubs = new Set<() => void>();

export let _emuInstallPoll: any = null;

export let _emuInstall: EmuInstall = { active: false, phase: '', pct: null, detail: '', error: null,
                                bytesDone: null, bytesTotal: null };

export function _publishInstall(next: EmuInstall) {
  _emuInstall = next;
  [..._emuInstallSubs].forEach((f) => f());
}

export function _pollInstall() {
  if (_emuInstallPoll) return;
  _emuInstallPoll = setInterval(async () => {
    try {
      const r = await emulatorInstallState();
      _publishInstall({
        active: !!r?.active, phase: r?.phase || '',
        pct: r?.pct ?? null, detail: r?.detail || '', error: r?.error || null,
        bytesDone: r?.bytes_done ?? null, bytesTotal: r?.bytes_total ?? null,
      });
      if (!r?.active) {
        clearInterval(_emuInstallPoll); _emuInstallPoll = null;
        // The emulator either exists now or the attempt failed — either way the
        // cached status is stale, and a fresh install ships zero cores, so the
        // Cores page needs to re-read too.
        await loadEmulatorStatus(true);
        if (_wizardOpen) return;
        if (r?.error) toaster.toast({ title: 'RetroArch', body: r.error });
        else if (r?.installed) {
          // Folders the install moved off the emulator that was removed. Worth
          // saying: it changes where saves and BIOS files land from now on.
          const fixed: string[] = r?.repaired || [];
          toaster.toast({
            title: 'RetroArch',
            body: fixed.length
              ? `Installed, and pointed ${fixed.join(' and ').toLowerCase()} at it.`
              : 'Installed',
          });
        }
      }
    } catch { /* keep polling; a dropped IPC frame isn't a failure */ }
  }, 1000);
}

export async function startEmulatorInstall() {
  _publishInstall({ active: true, phase: 'Starting…', pct: null, detail: '', error: null, bytesDone: null, bytesTotal: null });
  try {
    const r = await installEmulator();
    if (!r?.success) {
      _publishInstall({ active: false, phase: '', pct: null, detail: '', error: r?.message || 'Could not start the install', bytesDone: null, bytesTotal: null });
      // The wizard's Emulator step renders install.error itself.
      if (!_wizardOpen) toaster.toast({ title: 'RetroArch', body: r?.message || 'Could not start the install' });
      return;
    }
    _pollInstall();
  } catch (e) {
    _publishInstall({ active: false, phase: '', pct: null, detail: '', error: String(e), bytesDone: null, bytesTotal: null });
  }
}

export function useEmulatorInstall(): EmuInstall {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    _emuInstallSubs.add(f);
    return () => { _emuInstallSubs.delete(f); };
  }, []);
  return _emuInstall;
}

// "142 MB of 409 MB" while the sizes are known, '' when flatpak's ref table
// couldn't be read — better to say nothing than to quote a made-up total.
// flatpak reports SI sizes, so divide by 1000, not 1024, to match what it and
// Flathub show for the same app.
export function installSize(s: EmuInstall): string {
  if (!s.bytesTotal) return '';
  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  return s.bytesDone == null ? mb(s.bytesTotal)
    : `${mb(s.bytesDone)} of ${mb(s.bytesTotal)}`;
}

// The standalone emulator that owns a game's platform, installed or not — Eden
// for a Switch ROM. Matched on the same tokens the backend uses, against both
// the platform name and its slug, so "Nintendo Switch" and "switch" both hit.
export function standaloneFor(status: EmuStatus | null,
                       platform?: string | null,
                       slug?: string | null): EmuStandalone | null {
  if (!status?.standalone?.length) return null;
  const hay = `${platform || ''} ${slug || ''}`.toLowerCase();
  if (!hay.trim()) return null;
  return status.standalone.find((s) => s.platforms.some((p) => hay.includes(p))) || null;
}

// ─── Per-platform sync ───────────────────────────────────────────────────────
// Which platforms Ludo reads from RomM at all. The backend stores the DISABLED
// set (see main.py), so a platform added on the server after the user last
// looked syncs by default rather than being silently ignored.
//
// Switching one off never deletes anything: downloaded games stay on disk and
// stay in the library, and only listings for games that were never downloaded
// go. That is why the copy below says "stop syncing", never "remove".
export function usePlatformSync() {
  const [rows, setRows] = useState<any[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  // Slugs with a write in flight. A set, not a single slug: switches are quick
  // to flip and each write is a round-trip, so several are routinely open at
  // once and a scalar would blank the first one's "Saving…" the moment the
  // second started.
  const [saving, setSaving] = useState<Set<string>>(new Set());
  // The latest INTENDED disabled set, including toggles still in flight. `off`
  // is a render snapshot, so building the next set from it would let two quick
  // toggles each send a set that omits the other's change — last write wins and
  // silently reverts one of them.
  const offRef = useRef<Set<string>>(new Set());
  // A platform coming back ON needs a walk to bring its games in. Deferred to
  // the moment the user leaves rather than fired per toggle: turning three
  // platforms back on should cost one walk, not three — and re-fetching under
  // someone who is still flipping switches is the worst possible timing.
  const needsRefresh = useRef(false);

  const load = async () => {
    // Set on every call, not just the first: the wizard re-runs this once the
    // connection exists, and a reload that left `loading` false would let the
    // caller read the previous (unconnected, empty) answer as the real one.
    setLoading(true);
    try {
      const r = await getPlatformSync();
      if (r?.success) {
        setRows(r.platforms || []);
        const stored = new Set<string>(r.disabled || []);
        offRef.current = stored;
        setOff(stored);
        setConnected(!!r.connected);
        setUnavailable(!!r.unavailable);
      }
    } catch { /* leave the page in its loading state; the retry below covers it */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // The platform list shares a server with the library fetch, so an empty
  // answer during a big walk is a timing accident, not a verdict. Same
  // self-healing retry the BIOS page uses.
  useEffect(() => {
    if (!unavailable) return;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [unavailable]);

  const mark = (slug: string, busy: boolean) => setSaving((prev) => {
    const next = new Set(prev);
    if (busy) next.add(slug); else next.delete(slug);
    return next;
  });

  const toggle = async (slug: string) => {
    // Built from the ref, so a toggle started while another is still in flight
    // sends both changes rather than clobbering the earlier one.
    const turningOff = !offRef.current.has(slug);
    const next = new Set(offRef.current);
    if (turningOff) next.add(slug); else next.delete(slug);
    // Optimistic: the switch has to move under the thumb. A failed write puts
    // it back, which is the only honest thing to show if nothing was stored.
    offRef.current = next;
    setOff(next);
    mark(slug, true);
    try {
      const r = await setPlatformSync([...next]);
      if (r?.success === false) throw new Error(r.message || 'failed');
      if (r?.needs_refresh) needsRefresh.current = true;
    } catch {
      // Undo THIS slug only, against whatever the current intent is. Restoring
      // the snapshot taken before this write would also wipe out any toggle the
      // user made while it was in flight — including ones that succeeded.
      const undone = new Set(offRef.current);
      if (turningOff) undone.delete(slug); else undone.add(slug);
      offRef.current = undone;
      setOff(undone);
    } finally {
      mark(slug, false);
    }
  };

  useEffect(() => () => {
    if (!needsRefresh.current) return;
    needsRefresh.current = false;
    try {
      refreshFromRomm(false)
        .then(() => _broadcastLibRefresh())
        .catch(() => { /* the next connect reconciles it anyway */ });
    } catch { /* ignore */ }
  }, []);

  const on = rows.filter((r) => !off.has(r.slug));
  return {
    rows, off, loading, connected, unavailable, saving, toggle, reload: load,
    enabledCount: on.length,
    enabledRoms: on.reduce((n, r) => n + (r.rom_count || 0), 0),
    totalRoms: rows.reduce((n, r) => n + (r.rom_count || 0), 0),
  };
}

export function PlatformSyncList({ sync }: { sync: ReturnType<typeof usePlatformSync> }) {
  const { rows, off, loading, connected, unavailable, saving, toggle } = sync;
  if (loading) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />} title="Reading your platforms…" />;
  }
  if (!connected) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />}
      title="Not connected to RomM"
      subtitle="Connect to RomM to choose which platforms to sync." />;
  }
  if (unavailable) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />}
      title="Couldn’t read your platforms"
      subtitle="Your server didn’t answer. Retrying…" />;
  }
  if (!rows.length) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />}
      title="No platforms on the server"
      subtitle="Add one in RomM and it’ll show up here." />;
  }
  return (
    <>
      {rows.map((row) => {
        const isOff = off.has(row.slug);
        const count = (row.rom_count || 0).toLocaleString();
        return (
          <V2SettingsRow key={row.slug}
            bareIcon
            icon={<PlatformIcon slug={row.slug} size={28} />}
            title={row.name}
            subtitle={saving.has(row.slug)
              ? 'Saving…'
              : isOff
                ? `Not syncing — ${count} game${row.rom_count === 1 ? '' : 's'} left on RomM.`
                : `${count} game${row.rom_count === 1 ? '' : 's'}`}
            onClick={() => toggle(row.slug)}
            right={<V2Switch checked={!isOff} />} />
        );
      })}
    </>
  );
}

// Home dashboard — faithful to RomM v2 Home.vue: horizontal CardRows
// (Continue playing / Recently added / Platforms / Collections).
// Home banner for the two emulator states that change what the app can do:
// nothing installed (games download but can't launch), and a folder pointing at
// an emulator we don't launch — whether because it was uninstalled or because
// the user has both and we run the other one (sync writes where nothing reads,
// while still reporting success). Every other stale path is a quiet
// warning row in Settings ▸ Folders instead — see FoldersSection.
// Install progress. Determinate once flatpak reports a percentage, and a moving
// indeterminate sweep before that — resolving refs and verifying take a while
// with no numbers attached, and a bar frozen at 0% looks like a hung download.
export function InstallProgressBar({ pct }: { pct: number | null }) {
  const known = pct != null;
  return (
    <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{
        flex: '1 1 auto', height: '6px', borderRadius: V2.radiusPill,
        background: 'rgba(255,255,255,0.12)', overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: known ? 0 : undefined,
          width: known ? `${Math.max(2, Math.min(100, pct!))}%` : '35%',
          borderRadius: V2.radiusPill,
          background: `linear-gradient(90deg, ${V2.brand}, ${V2.brandHover})`,
          transition: known ? 'width 0.4s ease-out' : 'none',
          animation: known ? undefined : 'rommIndet 1.4s linear infinite',
        }} />
      </div>
      <span style={{
        fontSize: '11px', fontWeight: 700, color: V2.fg2,
        minWidth: '34px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
      }}>{known ? `${pct}%` : '…'}</span>
      {/* Per-component keyframes, the convention everywhere else in this file.
          `spin` is here too because the banner's own Fix button asks for it.
          The offsets are in units of the SWEEPER's width (35% of the track), so
          -115% is what actually parks it off the left edge and 300% clears the
          right — a smaller start left it half-visible at 0%, popping in. */}
      <style>{`
        @keyframes rommIndet {
          0%   { transform: translateX(-115%); }
          100% { transform: translateX(300%); }
        }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
